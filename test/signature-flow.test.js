'use strict';
// Signing order for agreements outside the review workflow (invite-link records, imports):
// the seller approves & sends → the counterparty signs and uploads through the public link
// (or the seller uploads a copy received by email) → the CEO countersigns → the counterparty is
// emailed a download link. Also covers withdraw and return, and the paper flow for imports.
const {test}=require('node:test');const assert=require('node:assert/strict');
const seeds=require('./fixtures/workflow-seeds.json');
const url=process.env.TEST_DATABASE_URL;
if(url&&!/\/agreement_test(?:\?|$)/.test(url))throw new Error('Only the disposable agreement_test database is allowed.');
test('counterparty signs first, the CEO countersigns last', {skip:!url?'TEST_DATABASE_URL not set':false,timeout:120000},async()=>{
  Object.assign(process.env,{DATABASE_URL:url,NODE_ENV:'test',SIGNER_EMAIL:'signer@vendora.se',ADMIN_EMAILS:'owner@vendora.se,signer@vendora.se',SMTP_USER:'test@example.test',SMTP_PASS:'mock',GOOGLE_SERVICE_ACCOUNT_JSON:'',ANTHROPIC_API_KEY:'',AGREEMENT_WEBHOOK_URL:''});
  const db=require('../db');await db.init();
  const nodemailer=require('nodemailer');const mail=[];let failMail=false;
  nodemailer.createTransport=()=>({sendMail:async m=>{if(failMail)throw new Error('mock mail failure');mail.push(m);return {messageId:'test-message'};}});
  const app=require('../server'),auth=require('../auth');
  const owner=(await db.query("INSERT INTO users(email,name,onboarded_at) VALUES('owner@vendora.se','Test owner',now()) ON CONFLICT(email) DO UPDATE SET name=EXCLUDED.name RETURNING *")).rows[0];
  const signer=(await db.query("INSERT INTO users(email,name,onboarded_at) VALUES('signer@vendora.se','Test signer',now()) ON CONFLICT(email) DO UPDATE SET name=EXCLUDED.name RETURNING *")).rows[0];
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
  const cookie=u=>auth.COOKIE+'='+auth.signToken(u);const ids=[];
  async function api(p,method='GET',body,user=owner,rawHeaders){
    const headers={...(user?{Cookie:cookie(user)}:{}),...(body&&!Buffer.isBuffer(body)?{'Content-Type':'application/json'}:{}),...rawHeaders};
    const r=await fetch(base+p,{method,headers,body:body?Buffer.isBuffer(body)?body:JSON.stringify(body):undefined});let j;try{j=await r.json();}catch(_){j={};}return {status:r.status,body:j};
  }
  async function good(p,method,body,user,h){const r=await api(p,method,body,user,h);assert.equal(r.status,200,JSON.stringify(r.body));return r.body;}
  const lastMail=(pred)=>mail.slice().reverse().find(pred);
  try{
    const data={...seeds.ra,sig_name:'Jane Signer',sig_email:'jane@counterparty.example.test',_proposals:{pay:{original:'30',proposed:'45',comment:'internal'}},_accepted:['pay']};
    const made=await good('/api/agreements','POST',{type:'ra',data,status:'submitted',counterpartyName:data.name});ids.push(made.id);const id=made.id;

    // Approve & send: the counterparty gets the link, the record is locked, and the token never leaves the server.
    assert.equal((await api('/api/agreements/'+id+'/send-for-signature','POST',{email:'nope'})).status,400);
    const sent=await good('/api/agreements/'+id+'/send-for-signature','POST',{summary:{terms:[['Motpart',data.name]],deviations:['pay: 30 → 45']}});
    assert.equal(sent.status,'sent');assert.equal(sent.sent,true);assert.equal(sent.email,'jane@counterparty.example.test');
    const token=sent.link.match(/#agreementcopy=\d+\.([A-Za-z0-9_-]+)$/)[1];
    const requestMail=lastMail(m=>m.to==='jane@counterparty.example.test');assert.match(requestMail.subject,/ready for your signature/);assert.ok(requestMail.html.includes(sent.link));
    const stored=await good('/api/agreements/'+id);assert.equal(stored.agreement.status,'sent');assert.equal(stored.agreement.signature_token,undefined);assert.equal(stored.agreement.signature_requested_by,'owner@vendora.se');
    assert.equal((await api('/api/agreements/'+id,'PUT',{data:{...data,pay:'1'}})).status,409);
    assert.equal((await api('/api/agreements/'+id+'/status','PUT',{status:'generated'})).status,409);
    assert.equal((await api('/api/agreements/'+id+'/sign','POST',{},signer)).status,409,'the CEO cannot sign before the counterparty');
    const reminder=await good('/api/agreements/'+id+'/remind','POST',{});assert.equal(reminder.sent,true);assert.ok(lastMail(m=>/Reminder/.test(m.subject)).html.includes('#agreementcopy='+id+'.'+token));

    // The public link shows the agreement, never the negotiation bookkeeping.
    const pub=await good('/api/public-agreements/'+id+'?token='+token,'GET',undefined,null);
    assert.equal(pub.status,'sent');assert.equal(pub.data.pay,data.pay);assert.equal(pub.data._proposals,undefined);assert.equal(pub.data._accepted,undefined);assert.equal(pub.data._type,'ra');assert.equal(pub.counterparty,null);assert.equal(pub.vendora,null);
    assert.equal((await api('/api/public-agreements/'+id+'?token=wrong','GET',undefined,null)).status,404);
    assert.equal((await api('/api/public-agreements/999999?token='+token,'GET',undefined,null)).status,404);

    // The counterparty uploads their signed copy: validation, then success exactly once.
    const up=(h,body,q='?token='+token)=>api('/api/public-agreements/'+id+'/signed-copy'+q,'POST',body,null,{'Content-Type':'application/pdf',...h});
    assert.equal((await up({'X-Filename':'signed.pdf','X-Signer-Name':'Jane'},Buffer.from('%PDF-1.4'),'?token=wrong')).status,404);
    assert.equal((await up({'X-Filename':'signed.pdf'},Buffer.from('%PDF-1.4'))).status,400);
    assert.equal((await up({'X-Filename':'signed.exe','X-Signer-Name':'Jane'},Buffer.from('MZ'))).status,400);
    const uploaded=await up({'X-Filename':encodeURIComponent('Signed copy.pdf'),'X-Signer-Name':encodeURIComponent('Jane Signer')},Buffer.from('%PDF-1.4 signed'));
    assert.equal(uploaded.status,200,JSON.stringify(uploaded.body));assert.equal(uploaded.body.status,'pending_signature');
    assert.equal((await up({'X-Filename':'again.pdf','X-Signer-Name':'Jane'},Buffer.from('%PDF-1.4'))).status,409);
    const ceoMail=lastMail(m=>m.to==='signer@vendora.se');assert.match(ceoMail.subject,/Ready for your signature/);assert.ok(ceoMail.html.includes('#sign='+id));assert.match(ceoMail.html,/pay: 30 → 45/);
    assert.match(lastMail(m=>m.to==='owner@vendora.se').subject,/Signed by/);
    let row=(await good('/api/agreements/'+id)).agreement;assert.equal(row.status,'pending_signature');assert.equal(row.counterparty_signed_by,'Jane Signer');assert.ok(row.counterparty_signed_file);
    const files=await good('/api/agreements/'+id+'/files');assert.equal(files.files[0].filename,'Signed copy.pdf');assert.match(files.files[0].uploaded_by,/Jane Signer/);
    const pubPending=await good('/api/public-agreements/'+id+'?token='+token,'GET',undefined,null);assert.equal(pubPending.status,'pending_signature');assert.equal(pubPending.counterparty.filename,'Signed copy.pdf');

    // The CEO countersigns: fully signed, the counterparty gets the download link, Vendora's stamp is public.
    assert.equal((await api('/api/agreements/'+id+'/sign','POST',{},owner)).status,403);
    const signed=await good('/api/agreements/'+id+'/sign','POST',{},signer);assert.equal(signed.status,'signed');assert.equal(signed.notified,true);assert.equal(signed.data._vendoraSignature.title,'CEO');
    const doneMail=lastMail(m=>m.to==='jane@counterparty.example.test');assert.match(doneMail.subject,/Fully signed/);assert.ok(doneMail.html.includes('#agreementcopy='+id+'.'+token));
    const pubSigned=await good('/api/public-agreements/'+id+'?token='+token,'GET',undefined,null);assert.equal(pubSigned.status,'signed');assert.equal(pubSigned.data._vendoraSignature.name,signed.data._vendoraSignature.name);assert.equal(pubSigned.vendora.title,'CEO');assert.equal(pubSigned.counterparty.by,'Jane Signer');
    const listed=(await good('/api/agreements')).agreements.find(a=>a.id===id);assert.equal(listed.status,'signed');assert.equal(listed.counterparty_signed_by,'Jane Signer');assert.ok(listed.signature_sent_at);
    assert.equal((await api('/api/agreements/'+id+'/sign','POST',{},signer)).status,409);

    // A copy that came by email: the seller uploads it with the signer's name — same effect.
    const made2=await good('/api/agreements','POST',{type:'ra',data,status:'generated',counterpartyName:data.name});ids.push(made2.id);
    failMail=true;const sent2=await good('/api/agreements/'+made2.id+'/send-for-signature','POST',{email:'jane@counterparty.example.test'});failMail=false;
    assert.equal(sent2.sent,false);assert.ok(sent2.mailReason);assert.equal(sent2.status,'sent');
    const byMail=await good('/api/agreements/'+made2.id+'/files','POST',Buffer.from('%PDF-1.4 mailed copy'),owner,{'Content-Type':'application/pdf','X-Filename':'mailed.pdf','X-Signer-Name':encodeURIComponent('Jane Signer')});
    assert.equal(byMail.status,'pending_signature');assert.equal((await good('/api/agreements/'+made2.id)).agreement.counterparty_signed_by,'Jane Signer');
    // The CEO returns it: back to the seller, the link is dead, the signed copy stays in the archive.
    assert.equal((await api('/api/agreements/'+made2.id+'/return','POST',{note:''},signer)).status,400);
    await good('/api/agreements/'+made2.id+'/return','POST',{note:'Please fix the territory.'},signer);
    const token2=sent2.link.match(/\.([A-Za-z0-9_-]+)$/)[1];
    const returned=(await good('/api/agreements/'+made2.id)).agreement;assert.equal(returned.status,'generated');assert.equal(returned.counterparty_signed_at,null);assert.equal(returned.signature_note,'Please fix the territory.');
    assert.equal((await api('/api/public-agreements/'+made2.id+'?token='+token2,'GET',undefined,null)).status,404);
    assert.equal((await good('/api/agreements/'+made2.id+'/files')).files.length,1);

    // Withdraw while out for signature: editable again, link dead.
    const sent3=await good('/api/agreements/'+made2.id+'/send-for-signature','POST',{email:'jane@counterparty.example.test'});const token3=sent3.link.match(/\.([A-Za-z0-9_-]+)$/)[1];
    await good('/api/agreements/'+made2.id+'/withdraw','POST',{});
    assert.equal((await good('/api/agreements/'+made2.id)).agreement.status,'generated');
    assert.equal((await api('/api/public-agreements/'+made2.id+'?token='+token3,'GET',undefined,null)).status,404);
    await good('/api/agreements/'+made2.id,'PUT',{data:{...data,pay:'60'}});

    // Paper flow for imports is unchanged: an upload means fully signed.
    const imported=await good('/api/agreements','POST',{type:'ra',data,status:'imported',counterpartyName:data.name});ids.push(imported.id);
    const paper=await good('/api/agreements/'+imported.id+'/files','POST',Buffer.from('%PDF-1.4 paper'),owner,{'Content-Type':'application/pdf','X-Filename':'paper.pdf'});assert.equal(paper.status,'signed');
  }finally{
    for(const i of ids)await db.query('DELETE FROM agreements WHERE id=$1',[i]);
    await new Promise(r=>server.close(r));await db.pool.end();
  }
});

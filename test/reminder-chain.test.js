'use strict';
// A reminder went to the counterparty whatever the agreement was waiting for: with Troubadour signed and
// the agreement awaiting the CEO, "Remind" on the archive row told the counterparty to sign and upload
// (2026-11-09). Now the reminder goes to whoever the agreement is waiting for: the counterparty while
// they hold a link (to fill in their details while invited; to sign while out for signature), the CEO
// while the agreement awaits the countersignature, and nobody when nobody is waiting (draft, submitted,
// fully signed): the button is off, with the reason. The row, the archive panel and the signing view
// all say who will be reminded.
const {test,after}=require('node:test');const assert=require('node:assert/strict');
const fs=require('fs');
const seeds=require('./fixtures/workflow-seeds.json');
const url=process.env.TEST_DATABASE_URL;
if(url&&!/\/agreement_test(?:\?|$)/.test(url))throw new Error('Only the disposable agreement_test database is allowed.');
const chrome=[process.env.CHROME_BIN,'/usr/bin/chromium','/usr/bin/google-chrome'].find(p=>p&&fs.existsSync(p));

let shared=null;
async function boot(){
  Object.assign(process.env,{DATABASE_URL:url,NODE_ENV:'test',SIGNER_EMAIL:'signer@vendora.se',SIGNER_NAME:'Test CEO',ADMIN_EMAILS:'owner@vendora.se,signer@vendora.se',SMTP_USER:'test@example.test',SMTP_PASS:'mock',GOOGLE_SERVICE_ACCOUNT_JSON:'',ANTHROPIC_API_KEY:'',AGREEMENT_WEBHOOK_URL:''});
  const db=require('../db');await db.init();
  const nodemailer=require('nodemailer');const mail=[];
  nodemailer.createTransport=()=>({sendMail:async m=>{mail.push(m);return {messageId:'test-message'};}});
  const app=require('../server'),auth=require('../auth');
  const user=async(email,name)=>(await db.query("INSERT INTO users(email,name,onboarded_at) VALUES($1,$2,now()) ON CONFLICT(email) DO UPDATE SET name=EXCLUDED.name RETURNING *",[email,name])).rows[0];
  const owner=await user('owner@vendora.se','Test owner'),signer=await user('signer@vendora.se','Test CEO');
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
  const cookie=u=>auth.COOKIE+'='+auth.signToken(u);const ids=[];
  async function api(p,method='GET',body,u=owner,rawHeaders){
    const headers={...(u?{Cookie:cookie(u)}:{}),...(body&&!Buffer.isBuffer(body)?{'Content-Type':'application/json'}:{}),...rawHeaders};
    const r=await fetch(base+p,{method,headers,body:body?Buffer.isBuffer(body)?body:JSON.stringify(body):undefined});let j;try{j=await r.json();}catch(_){j={};}return {status:r.status,body:j};
  }
  async function good(p,method,body,u,h){const r=await api(p,method,body,u,h);assert.equal(r.status,200,p+' '+JSON.stringify(r.body));return r.body;}
  const close=async()=>{await new Promise(r=>server.close(r));for(const id of ids)await db.query('DELETE FROM agreements WHERE id=$1',[id]);await db.pool.end();};
  return {db,auth,mail,owner,signer,base,api,good,ids,close};
}
const ctx=()=>shared||(shared=boot());
after(async()=>{if(shared)await (await shared).close();});
const JANE='jane@counterparty.example.test';

test('the reminder goes to whoever the agreement is waiting for, and to nobody when nobody is',{skip:!url?'TEST_DATABASE_URL not set':false,timeout:120000},async()=>{
  const t=await ctx();const {api,good,mail,ids,signer}=t;
  const remind=id=>api('/api/agreements/'+id+'/remind','POST',{});
  const lastTo=to=>mail.slice().reverse().find(m=>m.to===to);

  // Draft and submitted: nobody holds a link, nobody is waiting.
  for(const status of ['draft','submitted']){
    const r=await good('/api/agreements','POST',{type:'ra',data:{...seeds.ra},status,counterpartyName:seeds.ra.name,counterpartyEmail:JANE});ids.push(r.id);
    const held=await remind(r.id);assert.equal(held.status,409,status);assert.match(held.body.error,/Nobody is waiting/);
  }
  // Invited: the counterparty is asked to fill in their details, through the fill link.
  const inv=await good('/api/agreements','POST',{type:'ra',data:{...seeds.ra},status:'invited',counterpartyName:seeds.ra.name,counterpartyEmail:JANE});ids.push(inv.id);
  const fill=await remind(inv.id);assert.equal(fill.status,200,JSON.stringify(fill.body));assert.equal(fill.body.kind,'fill');assert.equal(fill.body.who,JANE);assert.ok(fill.body.last_reminder_at);
  let m=lastTo(JANE);assert.match(m.subject,/^Reminder: Reseller Agreement with Vendora Nordic AB$/);assert.match(m.html,/Fill in your details/);assert.match(m.html,/#fill=/);
  // Invited without an address: nothing to send to.
  const noMail=await good('/api/agreements','POST',{type:'ra',data:{...seeds.ra},status:'invited',counterpartyName:seeds.ra.name});ids.push(noMail.id);
  const none=await remind(noMail.id);assert.equal(none.status,409);assert.match(none.body.error,/No counterparty email/);

  // Out for signature: the counterparty is asked to sign, through the signing link.
  const data={...seeds.ra,sig_name:'Jane Signer',sig_email:JANE};
  const made=await good('/api/agreements','POST',{type:'ra',data,status:'submitted',counterpartyName:data.name});ids.push(made.id);const id=made.id;
  const sent=await good('/api/agreements/'+id+'/send-for-signature','POST',{summary:{terms:[],deviations:[]}});assert.equal(sent.status,'sent');
  const token=sent.link.match(/#agreementcopy=\d+\.([A-Za-z0-9_-]+)$/)[1];
  const mailsBefore=mail.length;
  const sign=await remind(id);assert.equal(sign.status,200,JSON.stringify(sign.body));assert.equal(sign.body.kind,'sign');assert.equal(sign.body.who,JANE);
  m=lastTo(JANE);assert.match(m.html,/sign the agreement and upload the signed copy/);assert.ok(m.html.includes(sent.link),'the same signing link');assert.equal(mail.length,mailsBefore+1);

  // The counterparty has signed: the agreement waits for the CEO, so the CEO is reminded, with the signing view link.
  const up=await api('/api/public-agreements/'+id+'/signed-copy?token='+token,'POST',Buffer.from('%PDF-1.4 signed'),null,{'Content-Type':'application/pdf','X-Filename':encodeURIComponent('Signed copy.pdf'),'X-Signer-Name':encodeURIComponent('Jane Signer')});
  assert.equal(up.status,200,JSON.stringify(up.body));assert.equal(up.body.status,'pending_signature');
  const janeMails=mail.filter(x=>x.to===JANE).length;
  const ceo=await remind(id);assert.equal(ceo.status,200,JSON.stringify(ceo.body));assert.equal(ceo.body.kind,'ceo');assert.equal(ceo.body.who,'Test CEO');
  m=lastTo('signer@vendora.se');assert.match(m.subject,/^Reminder — ready for your signature: Reseller Agreement — /);
  assert.match(m.html,/Reminder: .* is waiting for your signature/);assert.match(m.html,/<strong>Jane Signer<\/strong> signed the Reseller Agreement/);assert.match(m.html,/awaits your countersignature/);
  assert.ok(m.html.includes('/#sign='+id),'the CEO gets their own signing view link');assert.equal(m.replyTo,'owner@vendora.se','replies go to the seller who sent it');
  assert.equal(mail.filter(x=>x.to===JANE).length,janeMails,'the counterparty is not told to sign again');
  const row=(await good('/api/agreements/'+id)).agreement;assert.ok(row.last_reminder_at);

  // Fully signed: nobody to remind.
  const signed=await good('/api/agreements/'+id+'/sign','POST',{},signer);assert.equal(signed.status,'signed');
  const done=await remind(id);assert.equal(done.status,409);assert.match(done.body.error,/fully signed/);
});

test('browser: the row, the panel and the signing view name who will be reminded, and are off when nobody is waiting',{skip:!url?'TEST_DATABASE_URL not set':!chrome?'Chrome unavailable':false,timeout:180000},async()=>{
  const t=await ctx();const {api,good,mail,ids,signer}=t;let browser;
  try{
    const data={...seeds.ra,sig_name:'Jane Signer',sig_email:JANE};
    const mk=async(status,extra={})=>{const r=await good('/api/agreements','POST',{type:'ra',data,status,counterpartyName:'Reminder '+status+' AB',counterpartyEmail:JANE,...extra});ids.push(r.id);return r.id;};
    const draft=await mk('draft');
    const pending=await mk('submitted');
    const sent=await good('/api/agreements/'+pending+'/send-for-signature','POST',{summary:{terms:[],deviations:[]}});
    const token=sent.link.match(/#agreementcopy=\d+\.([A-Za-z0-9_-]+)$/)[1];
    assert.equal((await api('/api/public-agreements/'+pending+'/signed-copy?token='+token,'POST',Buffer.from('%PDF-1.4 signed'),null,{'Content-Type':'application/pdf','X-Filename':'signed.pdf','X-Signer-Name':'Jane%20Signer'})).status,200);
    const done=await mk('submitted');
    const sent2=await good('/api/agreements/'+done+'/send-for-signature','POST',{summary:{terms:[],deviations:[]}});
    const token2=sent2.link.match(/#agreementcopy=\d+\.([A-Za-z0-9_-]+)$/)[1];
    assert.equal((await api('/api/public-agreements/'+done+'/signed-copy?token='+token2,'POST',Buffer.from('%PDF-1.4 signed'),null,{'Content-Type':'application/pdf','X-Filename':'signed.pdf','X-Signer-Name':'Jane%20Signer'})).status,200);
    assert.equal((await good('/api/agreements/'+done+'/sign','POST',{},signer)).status,'signed');

    const puppeteer=require('puppeteer-core');browser=await puppeteer.launch({executablePath:chrome,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
    const page=await browser.newPage();page.setDefaultTimeout(30000);const pageErrors=[];page.on('pageerror',e=>pageErrors.push(e.message));
    await page.setCookie({name:t.auth.COOKIE,value:t.auth.signToken(t.owner),url:t.base});
    await page.setViewport({width:1400,height:1400});
    await page.goto(t.base+'/#archive',{waitUntil:'networkidle0'});
    await page.waitForSelector('#ovRem_'+pending);
    const btn=id=>page.$eval('#ovRem_'+id,e=>{const b=e.previousElementSibling;return {disabled:b.disabled,title:b.title,text:e.textContent};});
    assert.deepEqual(await btn(pending),{disabled:false,title:'Remind Test CEO to countersign',text:''});
    assert.deepEqual(await btn(draft),{disabled:true,title:'Nobody is waiting — reminders go out while the counterparty has a link or the agreement awaits Test CEO',text:''});
    assert.deepEqual(await btn(done),{disabled:true,title:'Fully signed — nobody to remind',text:''});

    // The click: the CEO gets the mail, the row says so.
    const ceoMails=mail.filter(x=>x.to==='signer@vendora.se').length;
    await page.evaluate(id=>document.getElementById('ovRem_'+id).previousElementSibling.click(),pending);
    await page.waitForFunction(id=>/^sent .* · to Test CEO$/.test(document.getElementById('ovRem_'+id).textContent),{},pending);
    assert.equal(mail.filter(x=>x.to==='signer@vendora.se').length,ceoMails+1);
    assert.ok(!mail.slice(-1)[0].to.includes(JANE));

    // The archive panel and the signing view say the same.
    await page.evaluate(id=>archiveEdit(id),pending);
    await page.waitForFunction(()=>document.getElementById('archivePanel').style.display==='block'&&/Nudge/.test(document.getElementById('apRemindMsg').textContent));
    assert.equal(await page.$eval('#apRemindMsg',e=>e.textContent),'Nudge Test CEO to countersign');
    assert.equal(await page.$eval('#apRemindBtn',b=>b.disabled),false);
    await page.waitForFunction(()=>/Waiting for Test CEO to countersign/.test(document.body.innerText));
    assert.ok(await page.evaluate(()=>Array.from(document.querySelectorAll('a')).some(a=>a.textContent==='Send a reminder to Test CEO')),'the signing view offers the CEO reminder to the seller');
    await page.evaluate(id=>archiveEdit(id),draft);
    await page.waitForFunction(()=>/Nobody is waiting/.test(document.getElementById('apRemindMsg').textContent));
    assert.equal(await page.$eval('#apRemindBtn',b=>b.disabled),true);
    assert.deepEqual(pageErrors,[]);
  }finally{if(browser)await browser.close();}
});

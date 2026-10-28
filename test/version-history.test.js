'use strict';
// Every change to an agreement is kept as a version — who, when, what, and the full content as it
// stood afterwards — for agreements outside the review workflow too (saves, invites, submissions,
// sending for signature, both signatures, return and withdrawal). Any version can be downloaded as
// it was or, while the agreement is editable, restored as the current content; the content being
// replaced stays in the history. A record that predates history keeps its last saved state as a
// baseline the first time it changes.
const {test,after}=require('node:test');const assert=require('node:assert/strict');
const fs=require('fs');const path=require('path');
const seeds=require('./fixtures/workflow-seeds.json');
const url=process.env.TEST_DATABASE_URL;
if(url&&!/\/agreement_test(?:\?|$)/.test(url))throw new Error('Only the disposable agreement_test database is allowed.');
const chrome=[process.env.CHROME_BIN,'/usr/bin/chromium','/usr/bin/google-chrome'].find(p=>p&&fs.existsSync(p));

async function boot(){
  Object.assign(process.env,{DATABASE_URL:url,NODE_ENV:'test',SIGNER_EMAIL:'signer@vendora.se',ADMIN_EMAILS:'owner@vendora.se,signer@vendora.se',SMTP_USER:'test@example.test',SMTP_PASS:'mock',GOOGLE_SERVICE_ACCOUNT_JSON:'',ANTHROPIC_API_KEY:'',AGREEMENT_WEBHOOK_URL:''});
  const db=require('../db');await db.init();
  const nodemailer=require('nodemailer');const mail=[];
  nodemailer.createTransport=()=>({sendMail:async m=>{mail.push(m);return {messageId:'test-message'};}});
  const app=require('../server'),auth=require('../auth');
  const user=async(email,name)=>(await db.query("INSERT INTO users(email,name,onboarded_at) VALUES($1,$2,now()) ON CONFLICT(email) DO UPDATE SET name=EXCLUDED.name RETURNING *",[email,name])).rows[0];
  const owner=await user('owner@vendora.se','Test owner'),signer=await user('signer@vendora.se','Test signer'),other=await user('other@vendora.se','Someone else');
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
  const cookie=u=>auth.COOKIE+'='+auth.signToken(u);
  async function api(p,method='GET',body,u=owner){const r=await fetch(base+p,{method,headers:{Cookie:cookie(u),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});let j;try{j=await r.json();}catch(_){j={};}return {status:r.status,body:j};}
  async function good(p,method,body,u){const r=await api(p,method,body,u);assert.equal(r.status,200,p+' '+JSON.stringify(r.body));return r.body;}
  const versions=async id=>(await good('/api/agreements/'+id+'/versions')).versions;
  const actions=async id=>(await versions(id)).map(v=>v.revision+':'+v.action).reverse();
  const ids=[];
  const close=async()=>{await new Promise(r=>server.close(r));for(const id of ids)await db.query('DELETE FROM agreements WHERE id=$1',[id]);await db.pool.end();};
  return {db,auth,mail,owner,signer,other,server,base,cookie,api,good,versions,actions,ids,close};
}
// One app for the whole file: the db module is a singleton, so its pool is closed once, at the end.
let shared=null;const ctx=()=>shared||(shared=boot());
after(async()=>{if(shared)await (await shared).close();});

test('every change outside the workflow is a version; versions can be fetched and restored, never lost',{skip:!url?'TEST_DATABASE_URL not set':false,timeout:120000},async()=>{
  const t=await ctx();const {db,api,good,versions,actions,ids}=t;
  try{
    // Created → saved → an unchanged save is not a version.
    const data={...seeds.da,invName:'Ryan Example',invEmail:'ryan@counterparty.example.test'};
    const id=(await good('/api/agreements','POST',{type:'da',data,status:'submitted',counterpartyName:data.name,counterpartyEmail:'ryan@counterparty.example.test'})).id;ids.push(id);
    assert.deepEqual(await actions(id),['1:created']);
    let v=(await versions(id))[0];assert.equal(v.actor,'Test owner');assert.equal(v.status,'submitted');assert.ok(v.created_at);
    const changed={...data,terr:'Not Poland'};
    await good('/api/agreements/'+id,'PUT',{data:changed,status:'generated',counterpartyName:data.name});
    await good('/api/agreements/'+id,'PUT',{data:changed,status:'generated',counterpartyName:data.name});   // same content again
    assert.deepEqual(await actions(id),['1:created','2:saved']);
    const listing=await good('/api/agreements/'+id+'/versions');
    assert.equal(listing.current,2);assert.equal(listing.restorable,true);assert.equal(listing.locked,false);assert.equal(listing.workflow,false);

    // A version is fetched as it was, with the agreement type for the document builder.
    const v1=(await good('/api/agreements/'+id+'/versions/1')).version;
    assert.equal(v1.type,'da');assert.equal(v1.data.terr,seeds.da.terr);assert.equal(v1.action,'created');
    const v2=(await good('/api/agreements/'+id+'/versions/2')).version;assert.equal(v2.data.terr,'Not Poland');assert.equal(v2.status,'generated');
    assert.equal((await api('/api/agreements/'+id+'/versions/99')).status,404);
    assert.equal((await api('/api/agreements/'+id+'/versions/abc')).status,404);

    // Sent for signature: a version with the recipient; while locked nothing is saved and nothing is restored.
    const sent=await good('/api/agreements/'+id+'/send-for-signature','POST',{email:'ryan@counterparty.example.test',summary:{terms:[],deviations:[]}});
    assert.deepEqual(await actions(id),['1:created','2:saved','3:sent-for-signature']);
    v=(await versions(id))[0];assert.equal(v.note,'to ryan@counterparty.example.test');assert.equal(v.status,'sent');
    assert.equal((await api('/api/agreements/'+id,'PUT',{data:{...changed,lead:'9'}})).status,409);
    const lockedRestore=await api('/api/agreements/'+id+'/versions/1/restore','POST',{});
    assert.equal(lockedRestore.status,409);assert.equal(lockedRestore.body.locked,true);
    assert.equal((await good('/api/agreements/'+id+'/versions')).restorable,false);
    assert.deepEqual(await actions(id),['1:created','2:saved','3:sent-for-signature']);

    // Withdrawn: a version, and editable again — restoring v1 makes a NEW version; v2 and v3 stay.
    await good('/api/agreements/'+id+'/withdraw','POST',{});
    assert.deepEqual(await actions(id),['1:created','2:saved','3:sent-for-signature','4:withdrawn']);
    const restored=await good('/api/agreements/'+id+'/versions/1/restore','POST',{});
    assert.equal(restored.revision,5);assert.equal(restored.data.terr,seeds.da.terr);assert.equal(restored.data._type,'da');
    const rec=(await good('/api/agreements/'+id)).agreement;
    assert.equal(rec.data.terr,seeds.da.terr);assert.equal(rec.data.invName,'Ryan Example');assert.equal(rec.status,'generated','restoring content does not change the lifecycle status');
    assert.equal(rec.workflow_revision,5);
    v=(await versions(id))[0];assert.equal(v.action,'restored');assert.equal(v.note,'version 1');assert.equal(v.actor,'Test owner');
    assert.equal((await good('/api/agreements/'+id+'/versions/2')).version.data.terr,'Not Poland','the replaced content is still there');

    // Status set by hand, the counterparty's electronic signature and the CEO's countersignature are versions too;
    // the signatures travel with the version they were put on, and a restored copy never carries them.
    await good('/api/agreements/'+id+'/status','PUT',{status:'draft'});
    await good('/api/agreements/'+id+'/status','PUT',{status:'draft'});   // no change, no version
    assert.equal((await versions(id))[0].action,'status-changed');assert.equal((await versions(id))[0].status,'draft');
    const sent2=await good('/api/agreements/'+id+'/send-for-signature','POST',{email:'ryan@counterparty.example.test',summary:{terms:[],deviations:[]}});
    const token=sent2.link.match(/#agreementcopy=\d+\.([A-Za-z0-9_-]+)$/)[1];
    const signed=await fetch(t.base+'/api/public-agreements/'+id+'/sign?token='+token,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Ryan Example',title:'Director',email:'ryan@counterparty.example.test',confirmed:true})});
    assert.equal(signed.status,200,await signed.text());
    await good('/api/agreements/'+id+'/sign','POST',{},t.signer);
    const tail=(await actions(id)).slice(-3);
    assert.deepEqual(tail,['7:sent-for-signature','8:counterparty-signed','9:vendora-signed']);
    const all=await versions(id);
    assert.equal(all.find(x=>x.revision===8).actor,'Ryan Example (counterparty)');assert.equal(all.find(x=>x.revision===8).note,'electronic signature');
    assert.equal(all.find(x=>x.revision===9).status,'signed');
    const v9=(await good('/api/agreements/'+id+'/versions/9')).version;
    assert.equal(v9.data._vendoraSignature.name,'Andreas Höynälä');assert.equal(v9.data._counterpartySignature.method,'electronic');
    assert.equal((await api('/api/agreements/'+id+'/versions/2/restore','POST',{})).status,409,'a signed agreement is not restored');
    await good('/api/agreements/'+id+'/withdraw','POST',{});
    const back=await good('/api/agreements/'+id+'/versions/9/restore','POST',{});
    assert.equal(back.data._vendoraSignature,undefined);assert.equal(back.data._counterpartySignature,undefined);
    assert.deepEqual((await actions(id)).slice(-2),['10:withdrawn','11:restored']);

    // Only the owner (or an admin) sees the history.
    assert.equal((await api('/api/agreements/'+id+'/versions','GET',null,t.other)).status,404);
    assert.equal((await api('/api/agreements/'+id+'/versions/1','GET',null,t.other)).status,404);
    assert.equal((await api('/api/agreements/'+id+'/versions/1/restore','POST',{},t.other)).status,404);

    // A record from before history was kept: its last saved state becomes the baseline on its first change,
    // dated when it was last saved, so the content before the change can be compared with and brought back.
    const old=(await db.query(`INSERT INTO agreements (type, counterparty_name, data, status, created_by, created_by_name, created_at, updated_at)
      VALUES ('da','Old Partner',$1,'generated',$2,'Test owner','2026-01-05T09:00:00Z','2026-01-06T10:30:00Z') RETURNING id`,[{...seeds.da,name:'Old Partner',pay:'30'},t.owner.id])).rows[0];ids.push(old.id);
    assert.deepEqual(await versions(old.id),[]);
    await good('/api/agreements/'+old.id,'PUT',{data:{...seeds.da,name:'Old Partner',pay:'45'},status:'generated',counterpartyName:'Old Partner'});
    const oldVersions=await versions(old.id);
    assert.deepEqual(oldVersions.map(x=>x.revision+':'+x.action),['2:saved','1:baseline']);
    assert.equal(oldVersions[1].actor,'system');assert.equal(oldVersions[1].status,'generated');assert.equal(new Date(oldVersions[1].created_at).toISOString(),'2026-01-06T10:30:00.000Z');
    assert.equal((await good('/api/agreements/'+old.id+'/versions/1')).version.data.pay,'30');
    assert.equal((await good('/api/agreements/'+old.id+'/versions/2')).version.data.pay,'45');

    // Invite records and the counterparty's submission are versions with the counterparty as the actor.
    const inv=await good('/api/invites','POST',{type:'ra',data:{...seeds.ra},counterpartyName:seeds.ra.name,counterpartyEmail:'jane@counterparty.example.test'});ids.push(inv.id);
    assert.deepEqual(await actions(inv.id),['1:invited']);assert.equal((await versions(inv.id))[0].note,'to jane@counterparty.example.test');
    const sub=await fetch(t.base+'/api/agreements/'+inv.id+'/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:inv.token,data:{...seeds.ra,pay:'45'},counterpartyName:seeds.ra.name})});
    assert.equal(sub.status,200,await sub.text());
    assert.deepEqual(await actions(inv.id),['1:invited','2:submitted']);assert.equal((await versions(inv.id))[0].actor,seeds.ra.name+' (counterparty)');

    // Agreements in the review workflow keep their own versions (now with the status), and are not restored from history.
    const wf=(await good('/api/agreements','POST',{type:'ra',data:{...seeds.ra},status:'draft',counterpartyName:seeds.ra.name})).id;ids.push(wf);
    await good('/api/workflow/'+wf+'/start','POST',{});
    const wfv=await good('/api/agreements/'+wf+'/versions');
    assert.deepEqual(wfv.versions.map(x=>x.action),['start','created']);assert.equal(wfv.versions[0].status,'draft');assert.equal(wfv.workflow,true);assert.equal(wfv.restorable,false);
    assert.match((await api('/api/agreements/'+wf+'/versions/1/restore','POST',{})).body.error,/through the workflow/);

    // Deleting the agreement removes its history with it.
    await good('/api/agreements/'+old.id,'DELETE');
    assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM agreement_versions WHERE agreement_id=$1',[old.id])).rows[0].n,0);
  }finally{/* the shared app is closed after the last test */}
});

test('browser: the archive panel lists the versions, compares them, downloads and restores one',{skip:!url?'TEST_DATABASE_URL not set':!chrome?'Chrome unavailable':false,timeout:180000},async()=>{
  const t=await ctx();const {good,ids}=t;let browser;
  try{
    const data={...seeds.da,invName:'Ryan Example',invEmail:'ryan@counterparty.example.test'};
    const id=(await good('/api/agreements','POST',{type:'da',data,status:'generated',counterpartyName:data.name})).id;ids.push(id);
    await good('/api/agreements/'+id,'PUT',{data:{...data,terr:'Not Poland',pay:'45'},status:'generated',counterpartyName:data.name});
    await good('/api/agreements/'+id+'/send-for-signature','POST',{email:'ryan@counterparty.example.test',summary:{terms:[],deviations:[]}});
    await good('/api/agreements/'+id+'/withdraw','POST',{});

    const puppeteer=require('puppeteer-core');browser=await puppeteer.launch({executablePath:chrome,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
    const page=await browser.newPage();page.setDefaultTimeout(30000);const pageErrors=[],dialogs=[];
    page.on('pageerror',e=>pageErrors.push(e.message));page.on('dialog',async d=>{dialogs.push(d.message());await d.accept();});
    await page.setCookie({name:t.auth.COOKIE,value:t.auth.signToken(t.owner),url:t.base});
    await page.setViewport({width:1200,height:1400});
    await page.goto(t.base+'/',{waitUntil:'networkidle0'});
    await page.evaluate(id=>archiveEdit(id),id);
    await page.waitForFunction(()=>document.querySelectorAll('#apVersions .ap-version').length===4);
    const rows=await page.$$eval('#apVersions .ap-version',els=>els.map(e=>({no:e.querySelector('.ap-ver-no').textContent,what:e.querySelector('.ap-ver-what').textContent,who:e.querySelector('.ap-ver-who').textContent,current:!!e.querySelector('.ap-ver-cur'),restore:!!Array.from(e.querySelectorAll('a')).find(a=>/Restore/.test(a.textContent))})));
    assert.deepEqual(rows.map(r=>r.no),['v4','v3','v2','v1']);
    assert.equal(rows[0].what,'Signing request withdrawn');assert.equal(rows[0].current,true);assert.equal(rows[0].restore,false);
    assert.match(rows[1].what,/^Sent for signature · to ryan@counterparty\.example\.test/);assert.equal(rows[1].restore,true);
    assert.equal(rows[2].what,'Saved');assert.equal(rows[3].what,'Created');assert.equal(rows[3].restore,true);
    assert.match(rows[0].who,/^Test owner · \d{4}-\d\d-\d\d \d\d:\d\d$/);

    // What changed in v2: the two edited terms, labelled.
    await page.evaluate(()=>apShowChanges(2));
    await page.waitForFunction(()=>document.querySelector('#apDiff_2 table'));
    const diff=await page.$$eval('#apDiff_2 tr',trs=>trs.map(tr=>Array.from(tr.children).map(td=>td.textContent)));
    assert.deepEqual(diff,[['Payment terms (days)',String(seeds.da.pay),'→','45'],['Territory',seeds.da.terr,'→','Not Poland']]);

    // Download v1 as it was: the document builder gets v1's content and the file name says which version.
    await page.evaluate(()=>{window.saved=[];window.saveAs=(blob,name)=>{window.saved.push({name,size:blob.size});};apDownloadVersion(1);});
    await page.waitForFunction(()=>window.saved.length===1);
    const saved=await page.evaluate(()=>window.saved[0]);
    assert.match(saved.name,/_v1\.docx$/);assert.ok(saved.size>10000,'a real .docx was produced');

    // Restore v1: the form shows the old terms, the record holds them, and the history grew by one.
    assert.equal(await page.$eval('#da_terr',e=>e.value),'Not Poland');
    await page.evaluate(()=>apRestoreVersion(1));
    await page.waitForFunction(()=>document.querySelectorAll('#apVersions .ap-version').length===5);
    assert.match(dialogs.pop()||'',/Restore version 1/);
    assert.equal(await page.$eval('#da_terr',e=>e.value),seeds.da.terr);
    assert.equal(await page.$eval('#da_pay',e=>e.value),String(seeds.da.pay));
    assert.match(await page.$eval('#editBarStatus',e=>e.textContent),/Version 1 restored/);
    assert.equal(await page.$eval('#apVersions .ap-version .ap-ver-what',e=>e.textContent),'Earlier version restored · version 1');
    const rec=(await good('/api/agreements/'+id)).agreement;assert.equal(rec.data.terr,seeds.da.terr);assert.equal(rec.data.pay,String(seeds.da.pay));
    assert.equal(await page.evaluate(()=>formHasUnsavedEdits()),false,'a restored form is clean, not dirty');
    assert.deepEqual(pageErrors,[]);
  }finally{if(browser)await browser.close();}
});

test('the history is wired into every change, the schema and the archive panel',()=>{
  const read=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');
  const server=read('server.js'),html=read('index.html'),dbjs=read('db.js'),wf=read('workflow-api.js');
  for(const action of ['created','invited','submitted','saved','status-changed','signed-copy-uploaded','sent-for-signature','counterparty-signed','vendora-signed','returned','withdrawn','restored'])
    assert.match(server,new RegExp("await keepVersion\\([^,]+, '"+action+"'"),'server records '+action);
  assert.match(server,/app\.get\('\/api\/agreements\/:id\/versions'/);assert.match(server,/app\.get\('\/api\/agreements\/:id\/versions\/:revision'/);assert.match(server,/app\.post\('\/api\/agreements\/:id\/versions\/:revision\/restore'/);
  assert.match(dbjs,/ALTER TABLE agreement_versions ALTER COLUMN workflow_state DROP NOT NULL/);assert.match(dbjs,/ALTER TABLE agreement_versions ADD COLUMN IF NOT EXISTS status TEXT/);
  assert.match(wf,/INSERT INTO agreement_versions\(agreement_id,revision,data,workflow_state,actor,action,status\)/);
  const panel=html.match(/\nfunction apShowPanel\(a\)\{[\s\S]*?\n\}\n/)[0];assert.match(panel,/apLoadVersions\(\);/);
  assert.match(html,/<div id="apVersions"/);
  assert.match(html,/function downloadAgreementData\(type, data, suffix\)/);
  for(const fn of ['apLoadVersions','apDownloadVersion','apShowChanges','apRestoreVersion','versionDiff'])assert.match(html,new RegExp('\\nfunction '+fn+'\\('),fn);
});

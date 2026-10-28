'use strict';
// An agreement out for signature is locked. Corrections made while it is locked must never be lost
// silently: the review page (reached from an email link, so it does not know by itself) shows the
// lock, refuses to save or generate, and offers the withdrawal; the form never downloads unsaved
// edits of a locked record as if they were the approved version; and an email link whose snapshot
// is older than the archive says so instead of overwriting the newer version. A reopened record
// also shows who was invited (the invite contact looked like lost data before).
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('fs');const path=require('path');
const seeds=require('./fixtures/workflow-seeds.json');
const url=process.env.TEST_DATABASE_URL;
if(url&&!/\/agreement_test(?:\?|$)/.test(url))throw new Error('Only the disposable agreement_test database is allowed.');
const chrome=[process.env.CHROME_BIN,'/usr/bin/chromium','/usr/bin/google-chrome'].find(p=>p&&fs.existsSync(p));
const enc=o=>Buffer.from(JSON.stringify(o),'utf8').toString('base64');   // what encodeData() produces

test('browser: corrections to an agreement out for signature are never lost silently',{skip:!url?'TEST_DATABASE_URL not set':!chrome?'Chrome unavailable':false,timeout:180000},async()=>{
  Object.assign(process.env,{DATABASE_URL:url,NODE_ENV:'test',SIGNER_EMAIL:'signer@vendora.se',ADMIN_EMAILS:'owner@vendora.se,signer@vendora.se',SMTP_USER:'test@example.test',SMTP_PASS:'mock',GOOGLE_SERVICE_ACCOUNT_JSON:'',ANTHROPIC_API_KEY:'',AGREEMENT_WEBHOOK_URL:''});
  const db=require('../db');await db.init();
  const nodemailer=require('nodemailer');const mail=[];
  nodemailer.createTransport=()=>({sendMail:async m=>{mail.push(m);return {messageId:'test-message'};}});
  const app=require('../server'),auth=require('../auth');
  const owner=(await db.query("INSERT INTO users(email,name,onboarded_at) VALUES('owner@vendora.se','Test owner',now()) ON CONFLICT(email) DO UPDATE SET name=EXCLUDED.name RETURNING *")).rows[0];
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
  const cookie=auth.COOKIE+'='+auth.signToken(owner);
  async function api(p,method='GET',body){const r=await fetch(base+p,{method,headers:{Cookie:cookie,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});const j=await r.json();assert.equal(r.status,200,p+' '+JSON.stringify(j));return j;}
  const record=async id=>(await api('/api/agreements/'+id)).agreement;
  let browser,id;
  try{
    const submitted={...seeds.da,invName:'Ryan Example',invEmail:'ryan@counterparty.example.test',_proposals:{terr:{original:seeds.da.terr,proposed:'Not Poland',comment:'We have a distributor there'}}};
    id=(await api('/api/agreements','POST',{type:'da',data:submitted,status:'submitted',counterpartyName:submitted.name,counterpartyEmail:'ryan@counterparty.example.test'})).id;
    const reviewLink=d=>base+'/#review='+enc(Object.assign({},d,{_type:'da',_aid:id,_review:true}));
    const display=(page,sel)=>page.evaluate(s=>{const e=document.querySelector(s);return e?getComputedStyle(e).display:'missing';},sel);
    const barText=page=>page.$eval('#reviewBarText',e=>e.textContent);

    const puppeteer=require('puppeteer-core');browser=await puppeteer.launch({executablePath:chrome,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
    const page=await browser.newPage();page.setDefaultTimeout(30000);const pageErrors=[],dialogs=[];
    page.on('pageerror',e=>pageErrors.push(e.message));page.on('dialog',async d=>{dialogs.push(d.message());await d.accept();});
    await page.setCookie({name:auth.COOKIE,value:auth.signToken(owner),url:base});
    await page.setViewport({width:1200,height:1400});

    // 1. A fresh submission on the review page: nothing is locked, the proposal is accepted and saved.
    await page.goto(reviewLink(submitted),{waitUntil:'networkidle0'});
    await page.waitForFunction(()=>window._reviewRecord&&getComputedStyle(document.getElementById('reviewSaveBtn')).display!=='none');
    assert.equal(await display(page,'#reviewLock'),'none','a current, unlocked record shows no notice');
    assert.equal(await page.$eval('#reviewSaveBtn',b=>b.disabled),false);
    await page.click('#acc_terr');await page.click('#reviewSaveBtn');
    await page.waitForFunction(()=>document.getElementById('reviewBarText').textContent.includes('Saved to the archive'));
    assert.equal((await record(id)).data.terr,'Not Poland');

    // 2. Sent for signature: the same page, reopened from the email link, shows the lock and refuses everything.
    assert.equal((await api('/api/agreements/'+id+'/send-for-signature','POST',{email:'ryan@counterparty.example.test',summary:{terms:[],deviations:[]}})).status,'sent');
    await page.reload({waitUntil:'networkidle0'});
    await page.waitForFunction(()=>getComputedStyle(document.getElementById('reviewLock')).display==='block');
    const lockText=await page.$eval('#reviewLock',e=>e.textContent);
    assert.match(lockText,/Out for signature/);assert.match(lockText,/ryan@counterparty\.example\.test/);assert.match(lockText,/withdraw the signing request/i);
    assert.match(await page.$eval('#reviewStage',e=>e.innerHTML),/class="now">4 · Counterparty signs/);
    for(const sel of ['#reviewSaveBtn','#reviewCeoBtn','#reviewGenBtn','#rv_terr','#acc_terr'])assert.equal(await page.$eval(sel,b=>b.disabled),true,sel+' is disabled while locked');
    assert.match(await barText(page),/Locked while out for signature/);
    await page.evaluate(()=>{window.saved=0;window.saveAs=()=>{window.saved++;};generateFromReview();});
    assert.match(dialogs.pop()||'',/Nothing was downloaded.*locked while out for signature/);
    assert.equal(await page.evaluate(()=>window.saved),0,'no document is produced from a locked record');
    assert.equal((await record(id)).status,'sent');

    // 3. Withdraw from the review page: editable again, and the link's snapshot is now older than the archive.
    await page.click('#reviewWithdrawBtn');
    await page.waitForFunction(()=>document.getElementById('reviewBarText').textContent.includes('Withdrawn'));
    assert.match(dialogs.pop()||'',/Withdraw the signing request/);
    assert.equal((await record(id)).status,'generated');
    assert.equal(await page.$eval('#reviewSaveBtn',b=>b.disabled),false);assert.equal(await page.$eval('#rv_terr',b=>b.disabled),false);
    const staleText=await page.$eval('#reviewLock',e=>e.textContent);
    assert.equal(await display(page,'#reviewLock'),'block');assert.match(staleText,/archive has a newer version/);
    await page.click('#reviewReloadBtn');
    await page.waitForFunction(()=>window._reviewRecord&&document.getElementById('rv_terr')&&document.getElementById('rv_terr').value==='Not Poland');
    assert.equal(await display(page,'#reviewLock'),'none','the archive version is current, so no notice');
    await page.$eval('#rv_lead',e=>{e.value='9';e.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.click('#reviewSaveBtn');
    await page.waitForFunction(()=>document.getElementById('reviewBarText').textContent.includes('Saved to the archive'));
    assert.equal((await record(id)).data.lead,'9');

    // 4. The old email link, opened later: it warns that the archive is newer instead of overwriting it quietly.
    const stalePage=await browser.newPage();stalePage.setDefaultTimeout(30000);stalePage.on('pageerror',e=>pageErrors.push(e.message));
    await stalePage.goto(reviewLink(submitted),{waitUntil:'networkidle0'});
    await stalePage.waitForFunction(()=>getComputedStyle(document.getElementById('reviewLock')).display==='block');
    assert.match(await stalePage.$eval('#reviewLock',e=>e.textContent),/archive has a newer version/);
    assert.equal(await stalePage.$eval('#rv_lead',e=>e.value),String(seeds.da.lead));
    await stalePage.close();

    // 5. The form: a locked record with unsaved edits downloads nothing; after withdrawal the edits save,
    //    the Contract Lawyer's changes survive Save, and the invite contact is shown again.
    assert.equal((await api('/api/agreements/'+id+'/send-for-signature','POST',{email:'ryan@counterparty.example.test',summary:{terms:[],deviations:[]}})).status,'sent');
    const form=await browser.newPage();form.setDefaultTimeout(30000);const formDialogs=[];
    form.on('pageerror',e=>pageErrors.push(e.message));form.on('dialog',async d=>{formDialogs.push(d.message());await d.accept();});
    await form.setCookie({name:auth.COOKIE,value:auth.signToken(owner),url:base});
    await form.goto(base+'/',{waitUntil:'networkidle0'});
    await form.waitForFunction(()=>window._authUser&&window.archiveEdit);
    await form.evaluate(i=>archiveEdit(i),id);
    await form.waitForFunction(i=>window._editing&&window._editing.id===i&&document.getElementById('sigOverlay')&&getComputedStyle(document.getElementById('sigOverlay')).display!=='none',{},id);
    assert.equal(await form.$eval('#da_inv_name',e=>e.value),'Ryan Example');assert.equal(await form.$eval('#da_inv_email',e=>e.value),'ryan@counterparty.example.test');
    await form.evaluate(()=>closeSig());
    assert.match(await form.$eval('#editBarStatus',e=>e.textContent),/Locked/);
    assert.equal(await form.evaluate(()=>window._formDirty),false,'opening a record starts clean');
    assert.equal(await form.evaluate(()=>formHasUnsavedEdits()),false);
    await form.select('#da_lead','3');
    assert.equal(await form.evaluate(()=>window._formDirty),true);
    await form.evaluate(()=>{window.saved=0;window.saveAs=()=>{window.saved++;};generate();});
    assert.match(formDialogs.pop()||'',/Nothing was downloaded.*locked while out for signature/);
    assert.equal(await form.evaluate(()=>window.saved),0);
    assert.equal((await record(id)).data.lead,'9','the locked record is untouched');
    // A Contract Lawyer change alone also counts as unsaved work.
    await form.evaluate(()=>{window._formDirty=false;window._lawyerState.clauseOverrides={'da.s3.p1':'The Supplier appoints the Distributor as its sole distributor in the Territory (test wording).'};});
    assert.equal(await form.evaluate(()=>formHasUnsavedEdits()),true);
    // Withdrawn (here through the API, as the signing view does): the pending edits save, lawyer change included.
    await api('/api/agreements/'+id+'/withdraw','POST',{});
    await form.evaluate(i=>refreshEditing(i),id);
    await form.waitForFunction(()=>window._editing.status==='generated'&&!document.getElementById('editSaveBtn').disabled);
    await form.click('#editSaveBtn');
    await form.waitForFunction(()=>document.getElementById('editBarStatus').textContent.includes('Changes saved'));
    const saved=await record(id);
    assert.equal(saved.data.lead,'3');assert.equal(saved.data.invName,'Ryan Example');assert.equal(saved.data.terr,'Not Poland');
    assert.deepEqual(saved.data.clauseOverrides,{'da.s3.p1':'The Supplier appoints the Distributor as its sole distributor in the Territory (test wording).'},'Save keeps the Contract Lawyer\'s change');
    assert.equal(await form.evaluate(()=>formHasUnsavedEdits()),false,'a save is the new clean state');
    assert.deepEqual(pageErrors,[]);
  }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));if(id)await db.query('DELETE FROM agreements WHERE id=$1',[id]);await db.pool.end();}
});

test('the page wires the lock awareness in every path',()=>{
  const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
  assert.match(html,/sv\(p\+"_inv_name", d\.invName\); sv\(p\+"_inv_email", d\.invEmail\);/,'hydrateForm restores the invite contact');
  assert.match(html,/var formData = lawyerCarry\(readForm\(e\.type\)\);/,'Save changes carries the Contract Lawyer\'s work');
  assert.match(html,/refreshEditing\(id\); loadArchive\(\); if \(window\._reviewData\) reviewRefreshRecord\(\);/,'sending from the review page locks it there');
  assert.match(html,/if \(reviewLocked\(\)\) \{\n    alert\("Nothing was downloaded\./,'the review page never generates from a locked record');
  assert.match(html,/if \(editingLocked\(\) && window\._editing\.type === \["da","ra","rb"\]\[activeTab\] && formHasUnsavedEdits\(\)\) \{/,'the form never generates unsaved edits of a locked record');
  assert.match(html,/if\(r\.status===409\) reviewRefreshRecord\(\);/,'a refused save surfaces the lock');
});

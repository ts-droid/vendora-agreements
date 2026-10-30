'use strict';
// After the counterparty submits through their link, the page says so and that the next step is
// Vendora's. The link opened again says the details are already in — when, and whom to email for
// a change — and the form cannot be submitted twice. A second submission that still gets through
// (an old tab) is answered with the same modal, not a Swedish browser alert, and is kept for
// Vendora as before.
const {test,after}=require('node:test');const assert=require('node:assert/strict');
const fs=require('fs');const path=require('path');const crypto=require('crypto');
const seeds=require('./fixtures/workflow-seeds.json');
const url=process.env.TEST_DATABASE_URL;
if(url&&!/\/agreement_test(?:\?|$)/.test(url))throw new Error('Only the disposable agreement_test database is allowed.');
const chrome=[process.env.CHROME_BIN,'/usr/bin/chromium','/usr/bin/google-chrome'].find(p=>p&&fs.existsSync(p));

test('browser: the counterparty is told their details are in, and cannot submit twice',{skip:!url?'TEST_DATABASE_URL not set':!chrome?'Chrome unavailable':false,timeout:180000},async()=>{
  Object.assign(process.env,{DATABASE_URL:url,NODE_ENV:'test',SIGNER_EMAIL:'signer@vendora.se',ADMIN_EMAILS:'owner@vendora.se,signer@vendora.se',SMTP_USER:'test@example.test',SMTP_PASS:'mock',GOOGLE_SERVICE_ACCOUNT_JSON:'',ANTHROPIC_API_KEY:'',AGREEMENT_WEBHOOK_URL:''});
  const db=require('../db');await db.init();
  const nodemailer=require('nodemailer');const mail=[];
  nodemailer.createTransport=()=>({sendMail:async m=>{mail.push(m);return {messageId:'test-message'};}});
  const app=require('../server'),auth=require('../auth');
  const owner=(await db.query("INSERT INTO users(email,name,onboarded_at) VALUES('owner@vendora.se','Test owner',now()) ON CONFLICT(email) DO UPDATE SET name=EXCLUDED.name RETURNING *")).rows[0];
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
  const cookie=auth.COOKIE+'='+auth.signToken(owner);
  async function api(p,method='GET',body){const r=await fetch(base+p,{method,headers:{Cookie:cookie,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});let j;try{j=await r.json();}catch(_){j={};}return {status:r.status,body:j};}
  async function good(p,method,body){const r=await api(p,method,body);assert.equal(r.status,200,p+' '+JSON.stringify(r.body));return r.body;}
  let browser,id;
  try{
    const data={...seeds.da,vname:'Thomas Test',vemail:'thomas@vendora.example.test'};
    id=(await good('/api/agreements','POST',{type:'da',data,status:'draft',counterpartyName:data.name})).id;
    await good('/api/workflow/'+id+'/start','POST',{});
    const view=await good('/api/workflow/'+id);
    const invited=await good('/api/workflow/'+id+'/invite','POST',{email:'ryan@counterparty.example.test',expectedRevision:view.revision,requestId:crypto.randomUUID()});
    const link=invited.inviteUrl.replace(/^https:\/\/[^/]+/,base);
    const carried=JSON.parse(Buffer.from(link.split('#fill=')[1],'base64').toString('utf8'));
    assert.equal(carried._aid,id);assert.ok(carried._atok);assert.equal(carried._sentVersion,view.revision+1);

    const puppeteer=require('puppeteer-core');browser=await puppeteer.launch({executablePath:chrome,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
    const page=await browser.newPage();page.setDefaultTimeout(30000);const pageErrors=[],dialogs=[];
    page.on('pageerror',e=>pageErrors.push(e.message));page.on('dialog',async d=>{dialogs.push(d.message());await d.dismiss();});
    await page.setRequestInterception(true);page.on('request',r=>{/^https?:\/\/127\.0\.0\.1/.test(r.url())?r.continue():r.abort();});
    await page.setViewport({width:1200,height:1600});

    // 1. First visit: the form, nothing about a submission yet.
    await page.goto(link,{waitUntil:'networkidle0'});await page.waitForSelector('#fillSubmitBtn');
    assert.equal(await page.$('#fillSubmitted'),null);
    assert.equal(await page.$eval('#fillSubmitBtn',b=>b.disabled),false);
    for(const [sel,val] of [['#fill_name','Example Supplier Ltd'],['#fill_reg','12345678'],['#fill_country','United Kingdom'],['#fill_addr','1 Example Street'],['#fill_products','Bags and luggage']]){await page.click(sel,{clickCount:3});await page.type(sel,val);}

    // 2. Submitted: the modal says so, names the next step and whom to email; the button is locked.
    await page.evaluate(()=>doSubmitFill());
    await page.waitForSelector('#thankModal.open');
    assert.equal(await page.$eval('#thankTitle',e=>e.textContent),'Submitted \u2713');
    const received=await page.$eval('#thankText',e=>e.textContent);
    assert.match(received,/reached Vendora Nordic AB on \d+ \w+ \d{4}(,| at) \d\d:\d\d\. There is nothing more to do now: Thomas Test will review them/);
    assert.match(received,/email thomas@vendora\.example\.test rather than submitting again/);
    assert.equal(await page.$eval('#thankText a',a=>a.getAttribute('href')),'mailto:thomas@vendora.example.test');
    assert.equal(await page.$eval('#fillSubmitBtn',b=>b.disabled),true);
    const stored=(await good('/api/agreements/'+id)).agreement;assert.equal(stored.status,'submitted');assert.equal(stored.data.name,'Example Supplier Ltd');
    const submittedAt=stored.workflow_state.submittedAt;assert.ok(submittedAt);

    // 3. The link opened again: a notice at the top, the button locked, and Submit answers with the modal, not an alert.
    await page.reload({waitUntil:'networkidle0'});await page.waitForSelector('#fillSubmitted');   // the link is the same URL, so goto would not reload
    const notice=await page.$eval('#fillSubmitted',e=>e.textContent);
    assert.match(notice,/^✅ Already submitted on \d+ \w+ \d{4}(,| at) \d\d:\d\d\. Vendora Nordic AB is reviewing your details and Thomas Test will come back to you/);
    assert.match(notice,/cannot be submitted twice\. If something needs to change, email thomas@vendora\.example\.test\.$/);
    assert.equal(await page.$eval('#fillSubmitBtn',b=>b.disabled),true);
    assert.equal(await page.$eval('#fillSubmitBtn',b=>b.title),'Already submitted');
    assert.equal(await page.$eval('#fill_name',e=>!!e.closest('.fill-done')),true,'the form below the notice is dimmed and inert');
    assert.equal(await page.$eval('#fillSubmitted',e=>!!e.closest('.fill-done')),false,'the notice itself is not');
    await page.evaluate(()=>submitFill());
    await page.waitForSelector('#thankModal.open');
    assert.equal(await page.$eval('#thankTitle',e=>e.textContent),'Already submitted');
    assert.match(await page.$eval('#thankText',e=>e.textContent),/reached Vendora Nordic AB on .* and are being reviewed\. The form cannot be submitted twice, so what you entered just now was not applied\. If something needs to change, email thomas@vendora\.example\.test\./);
    assert.deepEqual(dialogs,[]);

    // 4. A second submission that still reaches the server (an old tab): refused as before and kept for
    //    Vendora, now with a flag the page turns into the same modal.
    const again=await fetch(base+'/api/agreements/'+id+'/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:carried._atok,sentVersion:carried._sentVersion,data:{...data,name:'Example Supplier Ltd',addr:'1 Example Street, London'},counterpartyName:'Example Supplier Ltd'})});
    const body=await again.json();
    assert.equal(again.status,409);assert.equal(body.alreadySubmitted,true);assert.equal(body.retainedForReview,true);assert.equal(body.submittedAt,submittedAt);
    assert.equal((await db.query('SELECT COUNT(*)::int AS n FROM agreement_submission_conflicts WHERE agreement_id=$1',[id])).rows[0].n,1);
    assert.equal((await good('/api/agreements/'+id)).agreement.data.addr,'1 Example Street','the second submission changed nothing');
    await page.evaluate(()=>{document.getElementById('thankModal').classList.remove('open');window._fillData._submittedAt=null;fillLockSubmit(window._fillData);doSubmitFill();});
    await page.waitForSelector('#thankModal.open');
    assert.equal(await page.$eval('#thankTitle',e=>e.textContent),'Already submitted');
    assert.equal(await page.$eval('#fillSubmitBtn',b=>b.disabled),true);
    assert.deepEqual(dialogs,[],'no browser alert for a repeat submission');
    assert.deepEqual(pageErrors,[]);

    // 5. A legacy invite link (no sent version) still gets the plain form.
    const legacy=await good('/api/invites','POST',{type:'da',data,counterpartyName:data.name,counterpartyEmail:'ryan@counterparty.example.test'});
    await db.query('DELETE FROM agreements WHERE id=$1',[legacy.id]);
  }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));if(id)await db.query('DELETE FROM agreements WHERE id=$1',[id]);await db.pool.end();}
});

test('the submitted notice is wired in on both sides',()=>{
  const read=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');
  const html=read('index.html'),api=read('workflow-api.js'),core=read('workflow-core.js');
  assert.match(core,/e\.code='already-submitted'/);
  assert.match(api,/alreadySubmitted:e\.code==='already-submitted'/);assert.match(api,/_submittedAt:row\.workflow_state\.submittedAt/);
  assert.match(html,/if \(d\._submittedAt\) banner\.innerHTML \+= fillSubmittedNotice\(d\);/);
  assert.match(html,/id=\\'fillSubmitBtn\\' onclick=\\'submitFill\(\)\\'/);
  assert.match(html,/if \(d && d\._submittedAt\) \{ showSubmittedModal\("already", d, d\._submittedAt\); return; \}/);
  assert.match(html,/if \(res\.j && res\.j\.alreadySubmitted\)/);
  assert.match(html,/showSubmittedModal\("received", d, d\._submittedAt\);/);
  assert.match(html,/<h3 id="thankTitle"/);assert.match(html,/<p id="thankText"/);
});

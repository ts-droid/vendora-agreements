'use strict';
// The logo is the way back to a clean start page. An agreement opened from the seller's email link
// (#workflow=id) stayed in the address bar, so every reload reopened it and nothing on the page led
// to a blank form (Troubadour, 2026-10-30). The logo is now a link to "/": the record is left behind,
// the forms are empty, the sign-in is kept, and unsaved edits are confirmed first. Cancel in the
// edit bar drops the hash too, so a reload after it does not bring the record back.
const {test,after}=require('node:test');const assert=require('node:assert/strict');
const fs=require('fs');const path=require('path');
const seeds=require('./fixtures/workflow-seeds.json');
const url=process.env.TEST_DATABASE_URL;
if(url&&!/\/agreement_test(?:\?|$)/.test(url))throw new Error('Only the disposable agreement_test database is allowed.');
const chrome=[process.env.CHROME_BIN,'/usr/bin/chromium','/usr/bin/google-chrome'].find(p=>p&&fs.existsSync(p));
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');

test('the logo is a plain link to the start page, guarded by the unsaved-changes check; Cancel drops the workflow hash',()=>{
  assert.match(html,/<a href="\/" class="brand-link" onclick="return leaveToStart\(event\)"[^>]*>\s*<span class="brand-mark on-light">\s*<img src="\/vendora-nordic\.png"/);
  const leave=html.slice(html.indexOf('function leaveToStart('),html.indexOf('function apShowPanel('));
  assert.match(leave,/if \(formHasUnsavedEdits\(\) && !confirm\("You have unsaved changes/);
  assert.match(leave,/ev\.preventDefault\(\); return false;/);
  assert.match(leave,/\n  return true;\n\}/);
  const exit=html.slice(html.indexOf('function exitEdit('),html.indexOf('function leaveToStart('));
  assert.match(exit,/\/\^#workflow=\/\.test\(window\.location\.hash\|\|""\)\) history\.replaceState\(null, "", window\.location\.pathname\+window\.location\.search\)/);
  // Counterparties never see the link: their pages hide the top bar.
  assert.equal((html.match(/document\.querySelector\("\.topbar"\)\.style\.display = "none"/g)||[]).length,2);
});

let shared=null;
async function boot(){
  Object.assign(process.env,{DATABASE_URL:url,NODE_ENV:'test',SIGNER_EMAIL:'signer@vendora.se',ADMIN_EMAILS:'owner@vendora.se,signer@vendora.se',SMTP_USER:'test@example.test',SMTP_PASS:'mock',GOOGLE_SERVICE_ACCOUNT_JSON:'',ANTHROPIC_API_KEY:'',AGREEMENT_WEBHOOK_URL:''});
  const db=require('../db');await db.init();
  const nodemailer=require('nodemailer');
  nodemailer.createTransport=()=>({sendMail:async()=>({messageId:'test-message'})});
  const app=require('../server'),auth=require('../auth');
  const owner=(await db.query("INSERT INTO users(email,name,onboarded_at) VALUES('owner@vendora.se','Test owner',now()) ON CONFLICT(email) DO UPDATE SET name=EXCLUDED.name RETURNING *")).rows[0];
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
  const cookie=auth.COOKIE+'='+auth.signToken(owner);
  async function good(p,method='GET',body){const r=await fetch(base+p,{method,headers:{Cookie:cookie,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});let j;try{j=await r.json();}catch(_){j={};}assert.equal(r.status,200,p+' '+JSON.stringify(j));return j;}
  const ids=[];
  const close=async()=>{await new Promise(r=>server.close(r));for(const id of ids)await db.query('DELETE FROM agreements WHERE id=$1',[id]);await db.pool.end();};
  return {db,auth,owner,base,good,ids,close};
}
const ctx=()=>shared||(shared=boot());
after(async()=>{if(shared)await (await shared).close();});

test('browser: from an agreement opened by its link, the logo lands on an empty start page; Cancel leaves the record behind',{skip:!url?'TEST_DATABASE_URL not set':!chrome?'Chrome unavailable':false,timeout:180000},async()=>{
  const t=await ctx();const {good,ids}=t;let browser;
  try{
    const data={...seeds.da,vname:'Thomas Test',vemail:'thomas@vendora.example.test'};
    const id=(await good('/api/agreements','POST',{type:'da',data,status:'draft',counterpartyName:data.name})).id;ids.push(id);
    await good('/api/workflow/'+id+'/start','POST',{});

    const puppeteer=require('puppeteer-core');browser=await puppeteer.launch({executablePath:chrome,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
    const page=await browser.newPage();page.setDefaultTimeout(30000);const pageErrors=[],dialogs=[];let answer=true;
    page.on('pageerror',e=>pageErrors.push(e.message));page.on('dialog',async d=>{dialogs.push(d.message());await (answer?d.accept():d.dismiss());});
    await page.setCookie({name:t.auth.COOKIE,value:t.auth.signToken(t.owner),url:t.base});
    await page.setViewport({width:1200,height:1400});
    const opened=async()=>{await page.goto(t.base+'/#workflow='+id,{waitUntil:'networkidle0'});await page.waitForFunction(()=>document.getElementById('editBar').style.display==='flex');};
    const editBar=()=>page.$eval('#editBar',e=>e.style.display);
    const value=sel=>page.$eval(sel,e=>e.value);
    const hash=()=>page.evaluate(()=>location.hash);

    // 1. The email link opens the record and keeps it in the address bar.
    await opened();
    assert.equal(await value('#da_name'),seeds.da.name);assert.equal(await hash(),'#workflow='+id);
    assert.equal(await page.$eval('a.brand-link',a=>a.getAttribute('href')),'/');

    // 2. Nothing unsaved: the logo leaves without asking. Empty form, no record, still signed in.
    await Promise.all([page.waitForNavigation({waitUntil:'networkidle0'}),page.click('a.brand-link')]);
    assert.deepEqual(dialogs,[]);
    assert.equal(await hash(),'');assert.equal(await page.evaluate(()=>location.pathname),'/');
    assert.equal(await editBar(),'none');assert.equal(await value('#da_name'),'');
    assert.equal(await page.evaluate(()=>window._editing),null);
    assert.equal(await page.$eval('#daTabBtn',e=>e.classList.contains('active')),true);
    assert.equal(await page.$eval('#userChip',e=>e.style.display),'inline');
    assert.match(await page.$eval('#userChip',e=>e.textContent),/Test owner/);
    assert.equal(await page.$eval('#archiveTabBtn',e=>e.style.display),'inline-block');
    await page.reload({waitUntil:'networkidle0'});
    assert.equal(await editBar(),'none');assert.equal(await value('#da_name'),'');

    // 3. Unsaved edits: the logo asks; declining stays on the record, accepting leaves it.
    await opened();await page.type('#da_products',' and more');
    answer=false;await page.click('a.brand-link');await new Promise(r=>setTimeout(r,500));
    assert.equal(dialogs.length,1);assert.match(dialogs[0],/unsaved changes/);
    assert.equal(await hash(),'#workflow='+id);assert.equal(await editBar(),'flex');
    assert.match(await value('#da_products'),/ and more$/);
    answer=true;await Promise.all([page.waitForNavigation({waitUntil:'networkidle0'}),page.click('a.brand-link')]);
    assert.equal(dialogs.length,2);assert.equal(await hash(),'');assert.equal(await value('#da_products'),'');

    // 4. Cancel in the edit bar leaves the record; a reload does not bring it back.
    await opened();
    await page.evaluate(()=>Array.from(document.querySelectorAll('#editBar button')).find(b=>b.textContent.trim()==='Cancel').click());
    assert.equal(await hash(),'');assert.equal(await editBar(),'none');assert.equal(await page.evaluate(()=>window._editing),null);
    await page.reload({waitUntil:'networkidle0'});
    assert.equal(await editBar(),'none');assert.equal(await value('#da_name'),'');
    assert.deepEqual(pageErrors,[]);
  }finally{if(browser)await browser.close();}
});

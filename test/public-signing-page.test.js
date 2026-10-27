'use strict';
// The counterparty's signing page (#agreementcopy=id.token) is public. With Google sign-in
// configured on the server — as in production — an anonymous visitor must still see the
// agreement and be able to sign electronically in the browser; the Vendora sign-in overlay
// must never cover the page. Vendora's own CEO link (#sign=id) keeps the sign-in gate.
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('fs');
const seeds=require('./fixtures/workflow-seeds.json');
const url=process.env.TEST_DATABASE_URL;
if(url&&!/\/agreement_test(?:\?|$)/.test(url))throw new Error('Only the disposable agreement_test database is allowed.');
const chrome=[process.env.CHROME_BIN,'/usr/bin/chromium','/usr/bin/google-chrome'].find(p=>p&&fs.existsSync(p));

test('browser: the counterparty signs through the public link without a Vendora login',{skip:!url?'TEST_DATABASE_URL not set':!chrome?'Chrome unavailable':false,timeout:120000},async()=>{
  Object.assign(process.env,{DATABASE_URL:url,NODE_ENV:'test',SIGNER_EMAIL:'signer@vendora.se',ADMIN_EMAILS:'owner@vendora.se,signer@vendora.se',SMTP_USER:'test@example.test',SMTP_PASS:'mock',GOOGLE_SERVICE_ACCOUNT_JSON:'',ANTHROPIC_API_KEY:'',AGREEMENT_WEBHOOK_URL:'',GOOGLE_CLIENT_ID:'test-client.apps.googleusercontent.com'});
  const db=require('../db');await db.init();
  const nodemailer=require('nodemailer');const mail=[];
  nodemailer.createTransport=()=>({sendMail:async m=>{mail.push(m);return {messageId:'test-message'};}});
  const app=require('../server'),auth=require('../auth');
  assert.equal(auth.googleEnabled,true,'this test must run with Google sign-in configured, like production');
  const owner=(await db.query("INSERT INTO users(email,name,onboarded_at) VALUES('owner@vendora.se','Test owner',now()) ON CONFLICT(email) DO UPDATE SET name=EXCLUDED.name RETURNING *")).rows[0];
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
  const cookie=auth.COOKIE+'='+auth.signToken(owner);
  async function api(p,method='GET',body){const r=await fetch(base+p,{method,headers:{Cookie:cookie,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});const j=await r.json();assert.equal(r.status,200,JSON.stringify(j));return j;}
  const overlay=page=>page.evaluate(()=>getComputedStyle(document.getElementById('authOverlay')).display);
  let browser,id;
  try{
    const data={...seeds.ra,sig_name:'Jane Signer',sig_title:'Managing Director',sig_email:'jane@counterparty.example.test'};
    const made=await api('/api/agreements','POST',{type:'ra',data,status:'submitted',counterpartyName:data.name});id=made.id;
    const sent=await api('/api/agreements/'+id+'/send-for-signature','POST',{summary:{terms:[],deviations:[]}});
    assert.equal(sent.status,'sent');const link=sent.link.replace(/^https:\/\/[^/]+/,base);
    const cfg=await (await fetch(base+'/api/config')).json();assert.ok(cfg.googleClientId,'sign-in is configured, so the overlay would appear on a gated page');

    const puppeteer=require('puppeteer-core');browser=await puppeteer.launch({executablePath:chrome,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
    const page=await browser.newPage();page.setDefaultTimeout(30000);const pageErrors=[];page.on('pageerror',e=>pageErrors.push(e.message));
    await page.setRequestInterception(true);page.on('request',r=>{/^https?:\/\/127\.0\.0\.1/.test(r.url())?r.continue():r.abort();});  // the page needs nothing from the internet
    await page.setViewport({width:1200,height:1400});

    // 1. An anonymous visitor (the counterparty) opens the link from the email: the agreement and the
    //    e-sign form, with no sign-in overlay and none of the app's own chrome. networkidle0 makes sure
    //    the app's start-up (config → auth) has had every chance to show the overlay.
    await page.goto(link,{waitUntil:'networkidle0'});
    await page.waitForSelector('#wf-sign-submit');
    assert.equal(await overlay(page),'none','the Vendora sign-in overlay must not cover the counterparty page');
    assert.equal(await page.evaluate(()=>getComputedStyle(document.querySelector('.topbar')).display),'none');
    const text=await page.$eval('.wf-public',e=>e.textContent);
    assert.match(text,/Reseller Agreement — Testpartner AB/);assert.match(text,/Sign electronically/);
    assert.equal(await page.$eval('#wf-sign-name',e=>e.value),'Jane Signer');
    assert.equal(await page.$eval('#wf-sign-email',e=>e.value),'jane@counterparty.example.test');

    // 2. She signs: draws on the pad, ticks the confirmation, submits — and the page shows her signature.
    const pad=await page.$('#wf-sign-pad');const box=await pad.boundingBox();
    await page.mouse.move(box.x+30,box.y+60);await page.mouse.down();await page.mouse.move(box.x+160,box.y+120,{steps:8});await page.mouse.move(box.x+260,box.y+50,{steps:8});await page.mouse.up();
    await page.click('#wf-sign-submit');
    assert.equal(await page.$eval('#wf-sign-status',e=>e.textContent),'Tick the confirmation to sign.');
    await page.click('#wf-sign-confirm');await page.click('#wf-sign-submit');
    await page.waitForSelector('[data-public-status="pending_signature"]');
    const done=await page.$eval('.wf-public',e=>e.textContent);
    assert.match(done,/Signed for Testpartner AB by Jane Signer, Managing Director electronically on /);
    assert.ok(await page.$('img.wf-sign-image'),'the drawn signature is shown');
    assert.equal(await overlay(page),'none');
    const row=(await api('/api/agreements/'+id)).agreement;
    assert.equal(row.status,'pending_signature');assert.equal(row.counterparty_signed_by,'Jane Signer');
    assert.equal(row.data._counterpartySignature.method,'electronic');assert.match(row.data._counterpartySignature.image,/^data:image\/png;base64,/);
    assert.ok(mail.find(m=>m.to==='signer@vendora.se'&&/Ready for your signature/.test(m.subject)),'the CEO is asked to countersign');

    // 3. Vendora's own CEO link still asks for a login (a fresh tab: a hash change alone would not reload).
    const ceo=await browser.newPage();ceo.setDefaultTimeout(30000);ceo.on('pageerror',e=>pageErrors.push(e.message));
    await ceo.setRequestInterception(true);ceo.on('request',r=>{/^https?:\/\/127\.0\.0\.1/.test(r.url())?r.continue():r.abort();});
    await ceo.goto(base+'/#sign='+id,{waitUntil:'networkidle0'});
    await ceo.waitForFunction(()=>getComputedStyle(document.getElementById('authOverlay')).display==='flex');
    assert.match(await ceo.$eval('#authOverlay',e=>e.textContent),/Sign in with your @vendora\.se account/);
    assert.deepEqual(pageErrors,[]);
  }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));if(id)await db.query('DELETE FROM agreements WHERE id=$1',[id]);await db.pool.end();}
});

test('the start-up gate exempts the public signing page and keeps the CEO link behind sign-in',()=>{
  const html=fs.readFileSync(require('path').join(__dirname,'..','index.html'),'utf8');
  const init=html.match(/\nfunction initApp\(\)\{[\s\S]*?\n\}\n/)[0];
  assert.match(init,/if \(hash && hash\.indexOf\("#agreementcopy="\)===0\) return;/);
  assert.ok(init.indexOf('#agreementcopy=')<init.indexOf('fetch("/api/auth/me")'),'the exemption comes before the auth round trip');
  assert.doesNotMatch(init,/#sign=/);
});

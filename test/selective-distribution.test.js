'use strict';
// Selective distribution per brand in the reseller agreement, switched on by naming the authorised brands.
// With no brands named the agreement reads exactly as before. With brands named: §3A (system, permitted
// and prohibited sales, criteria over time, marketplaces, breach without penalties, the Supplier's own
// undertaking), Appendix 4 with the criteria and the application process, an appointment per brand that
// is always non-exclusive (exclusive and selective cannot share a territory), no active-sales ban outside
// the territory (a hardcore restriction inside a selective system), sub-reselling pointing at 3A.3, two
// new material breaches, four appendices in the precedence, 3A.6 surviving, and websites notified rather
// than approved. The fill-in page is the application: the reseller must confirm the criteria, and the
// confirmation carries the server's timestamp into Appendix 1 and 4.
const {test,after}=require('node:test');const assert=require('node:assert/strict');
const fs=require('fs');const path=require('path');const crypto=require('crypto');
const seeds=require('./fixtures/workflow-seeds.json');
const clauses=require('../agreement-clauses');const D=require('../agreement-defaults.json');
const url=process.env.TEST_DATABASE_URL;
if(url&&!/\/agreement_test(?:\?|$)/.test(url))throw new Error('Only the disposable agreement_test database is allowed.');
const chrome=[process.env.CHROME_BIN,'/usr/bin/chromium','/usr/bin/google-chrome'].find(p=>p&&fs.existsSync(p));
const S3A=['ra.s3a.system','ra.s3a.sales','ra.s3a.unauthorised','ra.s3a.criteria','ra.s3a.marketplaces','ra.s3a.breach','ra.s3a.supplier'];
const off={...seeds.ra,...D.ra,_type:'ra'};
const on={...off,selbrands:'Brand A, Brand B',excl:'exclusive'};
const text=(id,d)=>clauses.text('ra',id,d);
const when=(id,d)=>clauses.catalog('ra').find(c=>c.id===id).when(d);

test('with no authorised brands the reseller agreement reads as before, and the §3A clauses stay out',()=>{
  for(const id of S3A)assert.equal(when(id,off),false,id);
  assert.equal(when('ra.s3.p1',off),true);
  assert.match(text('ra.s3.appointment',off),/^The Supplier hereby grants to the Reseller a non-exclusive right to market and sell the Products within the Territory/);
  assert.match(text('ra.s3.appointment',{...off,excl:'exclusive'}),/^The Supplier hereby grants to the Reseller a exclusive right/);
  assert.match(text('ra.s2.p1',off),/three \(3\) appendices/);
  assert.match(text('ra.no_subreselling',off),/without the prior written consent of the Supplier/);
  assert.doesNotMatch(text('ra.s14.p2',off),/Authorised Resellers/);
  assert.doesNotMatch(text('ra.s16.p5',off),/3A\.6/);
  assert.doesNotMatch(text('ra.s5.p2',off),/Appendix 4/);
  for(const d of [off,{...off,selbrands:'   '},{...off,selbrands:undefined}])for(const id of S3A)assert.equal(when(id,d),false);
});

test('with authorised brands the appointment is per brand and never exclusive, §3A is in, the active-sales ban is out, and the dependent clauses follow',()=>{
  for(const id of S3A)assert.equal(when(id,on),true,id);
  assert.equal(when('ra.s3.p1',on),false,'no active-sales ban outside the territory inside a selective system');
  const appt=text('ra.s3.appointment',on);
  assert.match(appt,/^The Supplier hereby appoints the Reseller as a non-exclusive Authorised Reseller, within the meaning of §3A, for the brands listed in Appendix 1/);
  assert.doesNotMatch(appt,/ a exclusive right| an exclusive right/);
  assert.match(appt,/appointing other Authorised Resellers within the Territory/);
  assert.match(appt,/passive sales \(unsolicited orders\) cannot be restricted/);
  assert.match(text('ra.s3a.system',on),/within the meaning of EU competition law on vertical agreements, operated separately for each brand/);
  assert.doesNotMatch(text('ra.s3a.system',on),/2022\/720/,'no regulation number in the contract text');
  assert.match(text('ra.s3a.sales',on),/\(i\) end users, including business customers purchasing the Products for their own use and not for resale, and \(ii\) other Authorised Resellers of the relevant brand\. Nothing in this Agreement restricts the Reseller’s freedom to determine its resale prices\./);
  assert.match(text('ra.s3a.unauthorised',on),/shall not sell or otherwise supply the Products to any reseller, distributor or other person purchasing for resale that is not an Authorised Reseller for the relevant brand/);
  assert.match(text('ra.s3a.criteria',on),/sixty \(60\) days’ written notice to all Authorised Resellers/);
  assert.match(text('ra.s3a.marketplaces',on),/does not prevent the Reseller from selling the Products online through its own websites/);
  const breach=text('ra.s3a.breach',on);
  assert.match(breach,/thirty \(30\) days/);assert.match(breach,/ninety \(90\) days/);assert.match(breach,/no obligation to repurchase/);assert.doesNotMatch(breach,/penalty|liquidated damages/i);
  assert.match(text('ra.s3a.supplier',on),/shall not supply the Products of that brand to resellers that are not Authorised Resellers/);
  assert.match(text('ra.no_subreselling',on),/nor act as a wholesaler of the Products\. Supplies to other resellers are permitted only as set out in §3A\.3/);
  assert.match(text('ra.s14.p2',on),/sale or supply of Products to resellers that are not Authorised Resellers for the brand concerned \(§3A\.3\); marketplace sales without authorisation;/);
  assert.match(text('ra.s2.p1',on),/four \(4\) appendices.*\(3\) Appendix 4; \(4\) Appendix 2; \(5\) Appendix 3/);
  assert.match(text('ra.s16.p5',on),/clause 3A\.6 as regards remaining stock, and 17/);
  assert.match(text('ra.s5.p2',on),/Selective Distribution Criteria in Appendix 4 form part of the Reseller’s obligations/);
  // The simplified and distributor agreements are untouched.
  assert.ok(!clauses.catalog('rb').some(c=>/3A/.test(c.label)));assert.ok(!clauses.catalog('da').some(c=>/3A/.test(c.label)));
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
  async function api(p,method='GET',body){const r=await fetch(base+p,{method,headers:{Cookie:cookie,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});let j;try{j=await r.json();}catch(_){j={};}return {status:r.status,body:j};}
  async function good(p,method,body){const r=await api(p,method,body);assert.equal(r.status,200,p+' '+JSON.stringify(r.body));return r.body;}
  const ids=[];
  const close=async()=>{await new Promise(r=>server.close(r));for(const id of ids)await db.query('DELETE FROM agreements WHERE id=$1',[id]);await db.pool.end();};
  return {db,auth,owner,base,api,good,ids,close};
}
const ctx=()=>shared||(shared=boot());
after(async()=>{if(shared)await (await shared).close();});

test('browser: the form locks exclusivity while brands are named, and the document carries §3A, Appendix 4 and the rows only then',{skip:!url?'TEST_DATABASE_URL not set':!chrome?'Chrome unavailable':false,timeout:120000},async()=>{
  const t=await ctx();let browser;
  try{
    const puppeteer=require('puppeteer-core');browser=await puppeteer.launch({executablePath:chrome,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
    const page=await browser.newPage();page.setDefaultTimeout(30000);const pageErrors=[];page.on('pageerror',e=>pageErrors.push(e.message));
    await page.setRequestInterception(true);page.on('request',r=>{/^https?:\/\/127\.0\.0\.1/.test(r.url())?r.continue():r.abort();});
    await page.setCookie({name:t.auth.COOKIE,value:t.auth.signToken(t.owner),url:t.base});
    await page.goto(t.base+'/',{waitUntil:'networkidle0'});
    // The form: naming brands locks the appointment to non-exclusive; clearing them unlocks it; both survive hydrate and read.
    const form=await page.evaluate(()=>{
      switchTab(1);
      const sel=document.getElementById('ra_excl'),b=document.getElementById('ra_selbrands');
      sel.value='exclusive';b.value='Brand A';b.dispatchEvent(new Event('input',{bubbles:true}));
      const locked={disabled:sel.disabled,excl:sel.value,read:readRAForm().selbrands};
      b.value='';b.dispatchEvent(new Event('input',{bubbles:true}));
      const unlocked={disabled:sel.disabled,excl:sel.value};
      hydrateForm('ra',{selbrands:'Brand B',excl:'exclusive'});
      const hydrated={disabled:sel.disabled,excl:sel.value,field:b.value,read:readRAForm().selbrands,excl2:readRAForm().excl};
      hydrateForm('ra',{selbrands:'',excl:'non-exclusive'});
      return {locked,unlocked,hydrated,cleared:{disabled:sel.disabled,field:b.value}};
    });
    assert.deepEqual(form,{locked:{disabled:true,excl:'non-exclusive',read:'Brand A'},unlocked:{disabled:false,excl:'non-exclusive'},hydrated:{disabled:true,excl:'non-exclusive',field:'Brand B',read:'Brand B',excl2:'non-exclusive'},cleared:{disabled:false,field:''}});

    // The document.
    const docText=d=>page.evaluate(async d=>{const r=await buildRA(d);return docxToText(await r.blob.arrayBuffer());},d);
    const base_=await docText({...seeds.ra,_type:'ra'});
    for(const s of ['APPENDIX 4','Selective Distribution System','Authorised brands (selective distribution','Selective Distribution Criteria','notify the Supplier in writing before selling through any new website'])assert.ok(!base_.includes(s),'standard agreement must not contain: '+s);
    assert.ok(base_.includes('three (3) appendices'));assert.ok(base_.includes('Outside the Territory, the Reseller shall refrain from actively seeking customers'));
    const sel=await docText({...seeds.ra,_type:'ra',selbrands:'Brand A, Brand B',excl:'exclusive'});
    for(const s of ['3A   Selective Distribution System','APPENDIX 4 — SELECTIVE DISTRIBUTION CRITERIA','Authorised brands (selective distribution, §3A)','Brand A, Brand B','Confirmation pending','four (4) appendices','non-exclusive Authorised Reseller, within the meaning of §3A','H   Application, decision and register','notify the Supplier in writing before selling through any new website','sale or supply of Products to resellers that are not Authorised Resellers'])assert.ok(sel.includes(s),'selective agreement must contain: '+s);
    assert.ok(!sel.includes('Outside the Territory, the Reseller shall refrain from actively seeking customers'),'the active-sales ban is gone');
    assert.ok(!/ a exclusive right| an exclusive right/.test(sel));
    const confirmed=await docText({...seeds.ra,_type:'ra',selbrands:'Brand A',sel_confirmed:true,sel_confirmed_at:'2026-10-30T12:00:00.000Z'});
    assert.ok(confirmed.includes('Confirmed by the Reseller on 2026-10-30'));
    assert.deepEqual(pageErrors,[]);
  }finally{if(browser)await browser.close();}
});


test('browser: the fill-in page is the application: the reseller must confirm the criteria, and the confirmation is stored with the server\'s timestamp',{skip:!url?'TEST_DATABASE_URL not set':!chrome?'Chrome unavailable':false,timeout:180000},async()=>{
  const t=await ctx();const {good,ids}=t;let browser;
  try{
    const data={...seeds.ra,selbrands:'Brand A',vname:'Thomas Test',vemail:'thomas@vendora.example.test'};
    const id=(await good('/api/agreements','POST',{type:'ra',data,status:'draft',counterpartyName:data.name})).id;ids.push(id);
    await good('/api/workflow/'+id+'/start','POST',{});
    const view=await good('/api/workflow/'+id);
    const invited=await good('/api/workflow/'+id+'/invite','POST',{email:'buyer@counterparty.example.test',expectedRevision:view.revision,requestId:crypto.randomUUID()});
    const link=invited.inviteUrl.replace(/^https:\/\/[^/]+/,t.base);
    const carried=JSON.parse(Buffer.from(link.split('#fill=')[1],'base64').toString('utf8'));
    const served=await (await fetch(t.base+'/api/public-invites/'+id+'?token='+encodeURIComponent(carried._atok)+'&version='+carried._sentVersion)).json();
    assert.equal(served.selbrands,'Brand A','the brands travel to the fill-in page');

    const puppeteer=require('puppeteer-core');browser=await puppeteer.launch({executablePath:chrome,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
    const page=await browser.newPage();page.setDefaultTimeout(30000);const pageErrors=[],dialogs=[];
    page.on('pageerror',e=>pageErrors.push(e.message));page.on('dialog',async d=>{dialogs.push(d.message());await d.accept();});
    await page.setRequestInterception(true);page.on('request',r=>{/^https?:\/\/127\.0\.0\.1/.test(r.url())?r.continue():r.abort();});
    await page.setViewport({width:1200,height:2000});
    await page.goto(link,{waitUntil:'networkidle0'});await page.waitForSelector('#fill_sel_confirm');
    assert.match(await page.$eval('#fill_sel_sec',e=>e.parentNode.textContent),/Brand A/);
    // A point of sale, then submit without the confirmation: refused on the page, nothing stored.
    for(const [sel,val] of [['#fill_name','Example Reseller AB'],['#fill_reg','556000-0000'],['#fill_country','Sweden'],['#fill_addr','Testgatan 1, Lomma'],['#fill_sig_name','Signe Example'],['#fill_sig_email','signe@counterparty.example.test'],['#fill_rc_notices_e','notices@counterparty.example.test']]){assert.ok(await page.$(sel),sel);await page.click(sel,{clickCount:3});await page.type(sel,val);}
    await page.evaluate(()=>{addPosRow('pos_web_rows','pos_web');const inputs=document.querySelectorAll('#pos_web_rows input');inputs[inputs.length-1].value='shop.example.test';});
    await page.click('#fillSubmitBtn');
    await page.waitForFunction(()=>document.getElementById('valModal').classList.contains('open'));
    const required=await page.$eval('#valList',e=>e.textContent);
    assert.match(required,/Required:.*Confirmation that you meet the Selective Distribution Criteria \(Appendix 4\) for Brand A/);
    assert.equal(await page.$eval('#valAnywayBtn',b=>b.textContent),'Go back and complete');
    assert.equal((await good('/api/workflow/'+id)).status,'invited');
    await page.click('#valAnywayBtn');await page.waitForFunction(()=>!document.getElementById('valModal').classList.contains('open'));
    // Confirmed: submitted, stored with the server's own timestamp, printed in the document.
    const before=Date.now();
    await page.click('#fill_sel_confirm');await page.click('#fillSubmitBtn');
    await page.waitForFunction(()=>{var e=document.getElementById('thankTitle');return !!e&&e.getBoundingClientRect().height>0;});
    const after_=await good('/api/workflow/'+id);
    assert.equal(after_.status,'submitted');assert.equal(after_.data.sel_confirmed,true);
    const at=Date.parse(after_.data.sel_confirmed_at);assert.ok(at>=before-1000&&at<=Date.now()+1000,'server timestamp '+after_.data.sel_confirmed_at);
    assert.deepEqual(after_.data.pos_web,['shop.example.test']);
    assert.deepEqual(pageErrors,[]);
  }finally{if(browser)await browser.close();}
});

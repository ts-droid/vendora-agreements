'use strict';
// The standard's version used to be one hash of the two template files: any change to any clause flagged
// every open case ("Standarden har uppdaterats"), broke every customer link and every signing page, and
// there was no way through except starting over. Now the version is per agreement type, derived from what
// that type's clauses render, so a change to the reseller agreement never disturbs an open distributor
// case. States from before carry the old file hash, which stands for that snapshot's per-type versions.
// When a case's own type did change, the panel shows the clauses whose text differs and the owner adopts
// the new version after reading them; that review is recorded as a version. Locked cases are withdrawn first.
const {test,after}=require('node:test');const assert=require('node:assert/strict');
const fs=require('fs');const path=require('path');const crypto=require('crypto');
const seeds=require('./fixtures/workflow-seeds.json');
const C=require('../workflow-core');
const url=process.env.TEST_DATABASE_URL;
if(url&&!/\/agreement_test(?:\?|$)/.test(url))throw new Error('Only the disposable agreement_test database is allowed.');
const chrome=[process.env.CHROME_BIN,'/usr/bin/chromium','/usr/bin/google-chrome'].find(p=>p&&fs.existsSync(p));
const LEGACY='3a3d3f01c4d760809dba0e9283066e5083d3489ca37569c0fb27f269054381ce';
const STALE='0'.repeat(64);
const MARKETPLACES=/Third-party online marketplaces\. The Reseller shall not list/;
// A baseline text as if the standard had moved on since: one clause worded differently, one missing, one extra.
function movedOn(baselineText){
  const blocks=baselineText.replace(MARKETPLACES,'Third-party online marketplaces. Old wording: the Reseller may not list').split('\n\n');
  const idx=blocks.findIndex(b=>b.startsWith('Audit (§11)'));assert.ok(idx>0,'the audit clause is in the benchmark');blocks.splice(idx,1);
  blocks.push('Old clause (§99)\nThis clause was dropped from the standard.');
  return blocks.join('\n\n');
}

test('the standard version is per agreement type, derived from the rendered clauses, and the legacy file hash still counts as current',()=>{
  for(const t of ['ra','rb','da']){assert.match(C.TEMPLATE_VERSIONS[t],/^[0-9a-f]{64}$/);assert.equal(C.templateVersionFor(t),C.TEMPLATE_VERSIONS[t]);}
  assert.equal(new Set(Object.values(C.TEMPLATE_VERSIONS)).size,3);
  for(const t of ['ra','rb','da'])assert.equal(C.templateCurrent({type:t,workflow_state:{templateVersion:LEGACY}}),true,t+': a state from before the change is current');
  const data=C.copy(seeds.ra);data._type='ra';const s=C.createState(data);
  assert.equal(s.templateVersion,C.TEMPLATE_VERSIONS.ra);
  const row={id:1,type:'ra',status:'draft',data,workflow_state:s,workflow_revision:1};
  assert.equal(C.templateCurrent(row),true);
  assert.ok(!C.signatureProblems(row).some(p=>/Standarden har uppdaterats/.test(p)));
  const stale={...row,workflow_state:{...s,templateVersion:C.TEMPLATE_VERSIONS.da}};
  assert.equal(C.templateCurrent(stale),false,'another type\'s version is never current for this type');
  assert.ok(C.signatureProblems(stale).some(p=>/Standarden har uppdaterats/.test(p)));
  assert.throws(()=>C.adoptTemplate(row,'Test owner','2026-10-30T10:00:00.000Z',''),/redan den gällande/);
  assert.match(fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8'),/"template-review":"New standard version adopted"/);
});

test('the review lists the clauses whose text changed; adopting records who, when and why and resets the baseline',()=>{
  const data=C.copy(seeds.ra);data._type='ra';const s=C.createState(data);
  const row={id:2,type:'ra',status:'draft',data,workflow_state:{...s,templateVersion:STALE,baselineText:movedOn(s.baselineText)},workflow_revision:3};
  const ch=C.templateChanges(row);
  assert.deepEqual(ch.changed.map(c=>c.label),['Third-party marketplaces (§3)']);
  assert.match(ch.changed[0].before,/Old wording/);assert.match(ch.changed[0].after,/shall not list/);
  assert.deepEqual(ch.added.map(c=>c.label),['Audit (§11)']);
  assert.deepEqual(ch.removed.map(c=>c.label),['Old clause (§99)']);
  const next=C.adoptTemplate(row,'Test owner','2026-10-30T10:00:00.000Z','Read the marketplace clause; fine for this customer.');
  assert.equal(next.templateVersion,C.TEMPLATE_VERSIONS.ra);
  assert.deepEqual(next.templateReviews,[{from:STALE,to:C.TEMPLATE_VERSIONS.ra,by:'Test owner',at:'2026-10-30T10:00:00.000Z',note:'Read the marketplace clause; fine for this customer.'}]);
  assert.equal(next.baselineText,s.baselineText,'the baseline is the standard the case now follows');
  assert.deepEqual(C.templateChanges({...row,workflow_state:next}),{changed:[],added:[],removed:[]});
  assert.deepEqual(next.items,s.items);assert.deepEqual(next.baseline,s.baseline,'nothing else in the state moves');
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
  // The case was baselined against a standard that has since moved on.
  const moveOn=async(id,baselineText)=>db.query("UPDATE agreements SET workflow_state=jsonb_set(jsonb_set(workflow_state,'{templateVersion}',to_jsonb($2::text)),'{baselineText}',to_jsonb($3::text)) WHERE id=$1",[id,STALE,baselineText]);
  const ids=[];
  const close=async()=>{await new Promise(r=>server.close(r));for(const id of ids)await db.query('DELETE FROM agreements WHERE id=$1',[id]);await db.pool.end();};
  return {db,auth,owner,base,api,good,moveOn,ids,close};
}
const ctx=()=>shared||(shared=boot());
after(async()=>{if(shared)await (await shared).close();});

test('browser: an invited case on an old standard shows the differences and blocks the links until the owner adopts the version; a locked case is withdrawn first',{skip:!url?'TEST_DATABASE_URL not set':!chrome?'Chrome unavailable':false,timeout:180000},async()=>{
  const t=await ctx();const {api,good,moveOn,ids}=t;let browser;
  try{
    const data={...seeds.ra,vname:'Thomas Test',vemail:'thomas@vendora.example.test'};
    const id=(await good('/api/agreements','POST',{type:'ra',data,status:'draft',counterpartyName:data.name})).id;ids.push(id);
    await good('/api/workflow/'+id+'/start','POST',{});
    let view=await good('/api/workflow/'+id);
    const invited=await good('/api/workflow/'+id+'/invite','POST',{email:'buyer@counterparty.example.test',expectedRevision:view.revision,requestId:crypto.randomUUID()});
    const carried=JSON.parse(Buffer.from(invited.inviteUrl.split('#fill=')[1],'base64').toString('utf8'));
    const publicLink='/api/public-invites/'+id+'?token='+encodeURIComponent(carried._atok)+'&version='+carried._sentVersion;
    assert.equal((await fetch(t.base+publicLink)).status,200,'the customer link works on the current standard');
    await moveOn(id,movedOn(view.state.baselineText));

    // 1. The case reports the differences and the problem; the invite and the customer link are held.
    view=await good('/api/workflow/'+id);
    assert.ok(view.signatureProblems.some(p=>/Standarden har uppdaterats/.test(p)));
    assert.deepEqual(view.templateReview.changed.map(c=>c.label),['Third-party marketplaces (§3)']);
    assert.deepEqual(view.templateReview.added.map(c=>c.label),['Audit (§11)']);
    assert.deepEqual(view.templateReview.removed.map(c=>c.label),['Old clause (§99)']);
    const again=await api('/api/workflow/'+id+'/invite','POST',{email:'buyer@counterparty.example.test',expectedRevision:view.revision,requestId:crypto.randomUUID()});
    assert.equal(again.status,409);assert.match(again.body.error,/Standardversionen har ändrats/);
    const held=await fetch(t.base+publicLink);assert.equal(held.status,409);assert.match((await held.json()).error,/arkiverade avtalsversionen/);

    // 2. In the panel: the differences are shown, the owner notes what they checked and adopts the version.
    const puppeteer=require('puppeteer-core');browser=await puppeteer.launch({executablePath:chrome,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
    const page=await browser.newPage();page.setDefaultTimeout(30000);const pageErrors=[],dialogs=[];
    page.on('pageerror',e=>pageErrors.push(e.message));page.on('dialog',async d=>{dialogs.push(d.message());await d.accept('Kontrollerat marknadsplatsklausulen.');});
    await page.setCookie({name:t.auth.COOKIE,value:t.auth.signToken(t.owner),url:t.base});
    await page.setViewport({width:1200,height:1600});
    await page.goto(t.base+'/#workflow='+id,{waitUntil:'networkidle0'});
    await page.waitForSelector('.wf-template');
    const shown=await page.$eval('.wf-template',e=>e.textContent);
    assert.match(shown,/Standarden har uppdaterats sedan ärendet började/);assert.match(shown,/Ändrad: Third-party marketplaces \(§3\)/);assert.match(shown,/Ny: Audit \(§11\)/);assert.match(shown,/Borttagen: Old clause \(§99\)/);
    assert.match(shown,/Old wording/);assert.match(shown,/shall not list/);
    assert.equal(await page.$eval('.wf-template button[data-wf="template-review"]',b=>b.disabled),false,'an invited case can adopt: its customer link is what is broken');
    await page.click('.wf-template button[data-wf="template-review"]');
    await page.waitForFunction(()=>!document.querySelector('.wf-template'));
    assert.equal(dialogs.length,1);assert.match(dialogs[0],/Versionsgranskning/);
    assert.deepEqual(pageErrors,[]);

    // 3. Recorded, and both links work again without a new invite.
    view=await good('/api/workflow/'+id);
    assert.equal(view.templateReview,null);assert.ok(!view.signatureProblems.some(p=>/Standarden har uppdaterats/.test(p)));
    assert.equal(view.state.templateVersion,C.TEMPLATE_VERSIONS.ra);
    assert.equal(view.state.templateReviews.length,1);assert.equal(view.state.templateReviews[0].by,'Test owner');assert.equal(view.state.templateReviews[0].from,STALE);
    assert.equal(view.state.templateReviews[0].note,'Kontrollerat marknadsplatsklausulen.');
    const versions=(await good('/api/agreements/'+id+'/versions')).versions;
    assert.equal(versions[0].action,'template-review');assert.equal(versions[0].actor,'Test owner');assert.equal(versions[0].revision,view.revision);
    assert.equal((await fetch(t.base+publicLink)).status,200,'the customer link works again');
    assert.equal(view.status,'invited');

    // 4. A case out for signature cannot adopt a version: the counterparty's page is held and the case is withdrawn first.
    const second=(await good('/api/agreements','POST',{type:'ra',data,status:'draft',counterpartyName:data.name})).id;ids.push(second);
    await good('/api/workflow/'+second+'/start','POST',{});
    const v2=await good('/api/workflow/'+second);
    const sent=await good('/api/agreements/'+second+'/send-for-signature','POST',{expectedRevision:v2.revision,summary:{terms:[],deviations:[]}});
    assert.equal(sent.status,'sent');
    const m=sent.link.match(/#agreementcopy=(\d+)\.([A-Za-z0-9_-]+)$/);assert.ok(m,'signing link');const signingApi='/api/public-agreements/'+m[1]+'?token='+m[2];
    assert.equal((await fetch(t.base+signingApi)).status,200,'the signing page works on the current standard');
    await moveOn(second,movedOn(v2.state.baselineText));
    const heldSigning=await fetch(t.base+signingApi);assert.equal(heldSigning.status,409);assert.match((await heldSigning.json()).error,/archived copy/);
    const refused=await api('/api/workflow/'+second+'/template-review','POST',{note:'',expectedRevision:v2.revision+2});
    assert.equal(refused.status,409);assert.match(refused.body.error,/låst/);
    const v3=await good('/api/workflow/'+second);
    assert.ok(v3.templateReview,'the review is shown for the locked case');
    await good('/api/agreements/'+second+'/withdraw','POST',{expectedRevision:v3.revision});
    const v4=await good('/api/workflow/'+second);
    await good('/api/workflow/'+second+'/template-review','POST',{note:'After withdrawal.',expectedRevision:v4.revision});
    const v5=await good('/api/workflow/'+second);assert.equal(v5.templateReview,null);assert.equal(v5.status,'submitted','a withdrawn workflow case is back at review');
  }finally{if(browser)await browser.close();}
});

'use strict';
// A distributor never fills in "signatory" fields: the distributor fill-in page has none, its
// signatory is the General Management / Authorised Signatory contact. The review workflow's
// readiness check, the signing page's prefill and the paper-copy prompt use that contact, so a
// distributor agreement can be approved and sent for signature at all. Separately, the territory
// checkboxes show the stored territory when an agreement is reopened: the form's defaults tick
// every country, which made a removed country look like it was back (and one click on any box
// would have written it back into the agreement).
const {test,after}=require('node:test');const assert=require('node:assert/strict');
const fs=require('fs');const path=require('path');
const seeds=require('./fixtures/workflow-seeds.json');
const C=require('../workflow-core');
const url=process.env.TEST_DATABASE_URL;
if(url&&!/\/agreement_test(?:\?|$)/.test(url))throw new Error('Only the disposable agreement_test database is allowed.');
const chrome=[process.env.CHROME_BIN,'/usr/bin/chromium','/usr/bin/google-chrome'].find(p=>p&&fs.existsSync(p));
const MGMT={label:'General Management / Authorised Signatory',p:{n:'Ryan Example',e:'ryan@counterparty.example.test',p:'',t:''},b:{}};
const distributor=extra=>{const d={...seeds.da,contacts:{...(seeds.da.contacts||{}),mgmt:MGMT}};delete d.sig_name;delete d.sig_email;delete d.sig_title;return {...d,...extra};};

test('the readiness check takes a distributor\'s authorised signatory contact as the signatory',()=>{
  const row=(type,d)=>({type,data:d,workflow_state:C.createState(d),workflow_revision:1,status:'submitted'});
  const sig=r=>C.signatureProblems(r).filter(p=>/sig_/.test(p));
  assert.deepEqual(sig(row('da',distributor())),[]);
  assert.deepEqual(C.signatory(distributor()),{name:'Ryan Example',title:'',email:'ryan@counterparty.example.test'});
  const nobody=distributor({contacts:{...(seeds.da.contacts||{}),mgmt:{label:MGMT.label,p:{},b:{}}}});
  assert.deepEqual(sig(row('da',nobody)),['Saknad uppgift: sig_name','Saknad uppgift: sig_email']);
  // Explicit signatory fields still win, and a reseller still needs them.
  assert.deepEqual(C.signatory(distributor({sig_name:'Other Person',sig_title:'CFO',sig_email:'other@counterparty.example.test'})),{name:'Other Person',title:'CFO',email:'other@counterparty.example.test'});
  assert.deepEqual(sig(row('ra',{...seeds.ra,sig_name:'Jane Signer',sig_email:'jane@counterparty.example.test'})),[]);
  assert.deepEqual(sig(row('ra',{...seeds.ra,sig_name:'',sig_email:''})),['Saknad uppgift: sig_name','Saknad uppgift: sig_email']);
});

let shared=null;
async function boot(){
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
  const ids=[];
  const close=async()=>{await new Promise(r=>server.close(r));for(const id of ids)await db.query('DELETE FROM agreements WHERE id=$1',[id]);await db.pool.end();};
  return {db,auth,mail,owner,base,cookie,api,good,ids,close};
}
const ctx=()=>shared||(shared=boot());
after(async()=>{if(shared)await (await shared).close();});

test('browser: a distributor agreement goes out for signature, the signing page is prefilled from the authorised signatory, and the territory form shows what is stored',{skip:!url?'TEST_DATABASE_URL not set':!chrome?'Chrome unavailable':false,timeout:180000},async()=>{
  const t=await ctx();const {api,good,ids}=t;let browser;
  try{
    // 1. In the review workflow, nothing about a signatory blocks the approval, and the request goes to the contact.
    const data=distributor({invName:'Ryan Example',invEmail:'ryan@counterparty.example.test'});
    const id=(await good('/api/agreements','POST',{type:'da',data,status:'draft',counterpartyName:data.name})).id;ids.push(id);
    await good('/api/workflow/'+id+'/start','POST',{});
    const view=await good('/api/workflow/'+id);
    assert.deepEqual(view.signatureProblems.filter(p=>/sig_/.test(p)),[],JSON.stringify(view.signatureProblems));
    const sent=await good('/api/agreements/'+id+'/send-for-signature','POST',{expectedRevision:view.revision,summary:{terms:[],deviations:[]}});
    assert.equal(sent.status,'sent');assert.equal(sent.email,'ryan@counterparty.example.test');
    assert.ok(t.mail.find(m=>m.to==='ryan@counterparty.example.test'),'the signing request went to the authorised signatory');
    const link=sent.link.replace(/^https:\/\/[^/]+/,t.base);
    // A second distributor still under review, for the archive panel.
    const second=(await good('/api/agreements','POST',{type:'da',data:distributor(),status:'draft',counterpartyName:data.name})).id;ids.push(second);
    await good('/api/workflow/'+second+'/start','POST',{});

    const puppeteer=require('puppeteer-core');browser=await puppeteer.launch({executablePath:chrome,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
    const page=await browser.newPage();page.setDefaultTimeout(30000);const pageErrors=[];page.on('pageerror',e=>pageErrors.push(e.message));
    await page.setRequestInterception(true);page.on('request',r=>{/^https?:\/\/127\.0\.0\.1/.test(r.url())?r.continue():r.abort();});
    await page.setViewport({width:1200,height:1400});

    // 2. The counterparty's signing page is prefilled with the authorised signatory — both ways of signing.
    await page.goto(link,{waitUntil:'networkidle0'});await page.waitForSelector('#wf-sign-submit');
    assert.equal(await page.$eval('#wf-sign-name',e=>e.value),'Ryan Example');
    assert.equal(await page.$eval('#wf-sign-email',e=>e.value),'ryan@counterparty.example.test');
    assert.equal(await page.$eval('#wf-signer-name',e=>e.value),'Ryan Example');

    // 3. Reopened from the archive: the territory boxes show the stored territory, not the form's defaults,
    //    and rebuilding the string from the boxes gives the stored territory back unchanged.
    await page.setCookie({name:t.auth.COOKIE,value:t.auth.signToken(t.owner),url:t.base});
    await page.goto(t.base+'/',{waitUntil:'networkidle0'});
    const boxes=await page.evaluate(()=>{
      hydrateForm('da',Object.assign({},window._seed||{},{terr:'Sweden, Norway and Finland'}));
      var ticked=['se','no','dk','fi','is','ee','lv','lt','pl'].filter(function(c){return document.getElementById('da_t_'+c).checked;});
      var stored=document.getElementById('da_terr').value;
      buildTerrStr('da');
      return {ticked:ticked,stored:stored,rebuilt:document.getElementById('da_terr').value,extra:document.getElementById('da_terr_extra').value};
    });
    assert.deepEqual(boxes,{ticked:['se','no','fi'],stored:'Sweden, Norway and Finland',rebuilt:'Sweden, Norway and Finland',extra:''});
    const all=await page.evaluate(()=>{hydrateForm('da',{terr:'Sweden, Norway, Denmark, Finland, Iceland, Estonia, Latvia, Lithuania and Poland'});return ['se','no','dk','fi','is','ee','lv','lt','pl'].every(function(c){return document.getElementById('da_t_'+c).checked;});});
    assert.equal(all,true,'a full territory ticks every box again');
    const other=await page.evaluate(()=>{hydrateForm('da',{terr:'Sweden and Germany'});buildTerrStr('da');return {pl:document.getElementById('da_t_pl').checked,extra:document.getElementById('da_terr_extra').value,terr:document.getElementById('da_terr').value};});
    assert.deepEqual(other,{pl:false,extra:'Germany',terr:'Sweden and Germany'});

    // 4. The archive panel of a workflow record points to the workflow's own approval step instead of the old link.
    await page.evaluate(id=>archiveEdit(id),second);
    await page.waitForFunction(()=>document.getElementById('archivePanel').style.display==='block'&&/review steps below/.test(document.getElementById('apSig').textContent));
    assert.equal(await page.$eval('#apSig',e=>!!e.querySelector('a[onclick^="sendForSignature"]')),false);
    // A draft still offers the fill-in link at the foot of the form.
    assert.equal(await page.evaluate(()=>getComputedStyle(document.getElementById('da_invite_next')).display),'none');

    // 5. Once the counterparty's details are in, the card at the foot of the form offers the approval instead of
    //    the fill-in link: unsaved edits are saved first, the dialog is prefilled with the signatory's email, and
    //    after sending the card points to the signing view.
    const third=(await good('/api/agreements','POST',{type:'da',data:distributor({invName:'Ryan Example',invEmail:'ryan@counterparty.example.test'}),status:'generated',counterpartyName:data.name})).id;ids.push(third);
    await page.evaluate(id=>archiveEdit(id),third);
    await page.waitForFunction(()=>getComputedStyle(document.getElementById('da_invite_next')).display==='block');
    assert.match(await page.$eval('#da_invite_next',e=>e.textContent),/Testpartner AB's details are in — approve & send for signature/);
    assert.equal(await page.evaluate(()=>getComputedStyle(document.getElementById('da_invite_next').parentNode.querySelector('.invite-fill')).display),'none','the fill-in link is tucked away');
    await page.select('#da_lead','3');
    await page.click('#da_approve_btn');
    await page.waitForFunction(()=>document.getElementById('sigOverlay')&&document.getElementById('sigOverlay').style.display==='block');
    assert.equal(await page.$eval('#sigEmail',e=>e.value),'ryan@counterparty.example.test');
    assert.equal((await good('/api/agreements/'+third)).agreement.data.lead,'3','the form was saved before the approval dialog opened');
    await page.click('#sigSendBtn');
    await page.waitForFunction(()=>/Sent ✓/.test(document.getElementById('sigMsg').textContent));
    assert.equal((await good('/api/agreements/'+third)).agreement.status,'sent');
    await page.waitForFunction(()=>/Out for signature/.test(document.getElementById('da_invite_next').textContent));
    assert.equal(await page.evaluate(()=>readinessText('Saknad uppgift: sig_name Saknad uppgift: addr')),'Missing: signatory name (General Management / Authorised Signatory). Missing: registered address.');
    await page.evaluate(()=>{closeSig();exitEdit();});
    assert.equal(await page.evaluate(()=>getComputedStyle(document.getElementById('da_invite_next')).display),'none','leaving the record brings the fill-in link back');
    assert.deepEqual(pageErrors,[]);
  }finally{if(browser)await browser.close();}
});

test('the signatory fallback and the territory restore are wired in',()=>{
  const read=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');
  const core=read('workflow-core.js'),ui=read('workflow-ui.js'),html=read('index.html');
  assert.match(core,/\nfunction signatory\(data\)/);assert.match(core,/signatory,signatureProblems/);
  assert.equal((ui.match(/signatoryOf\(/g)||[]).length,4,'the helper and its three uses: paper-copy prompt, e-sign prefill, paper-copy name');
  assert.doesNotMatch(ui,/v\.data\.sig_name/);
  const restore=html.match(/\nfunction restoreTerr\(prefix, terr\)\{[\s\S]*?\n\}\n/)[0];
  assert.match(restore,/cb\.checked=false/);
  assert.match(html,/if \(a\.workflow_state\) out \+= .*review steps below/);
  for(const id of ['da_invite_next','ra_invite_next'])assert.match(html,new RegExp('<div class="invite-next" id="'+id+'"'));
  assert.equal((html.match(/<div class="invite-fill">/g)||[]).length,2);
  for(const fn of ['syncInviteCard','approveFromForm','readinessText','inviteShowFill'])assert.match(html,new RegExp('\\nfunction '+fn+'\\('),fn);
  assert.equal((html.match(/syncInviteCard\(\);/g)||[]).length,3,'archiveEdit, refreshEditing and exitEdit keep the card in step');
  assert.match(ui,/if\(window\.syncInviteCard\)window\.syncInviteCard\(\);/);
});

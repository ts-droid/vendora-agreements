'use strict';
// Until now a counterparty could propose other values for the listed terms but had no way, through
// the fill-in page, to send changes to the wording itself or their own marked-up document: that went
// by email (BleeqUp's Excel, October 2026). The page now has a comments field and an attachment.
// The document goes up through the invite token before the submission and lands with the agreement's
// files; the comments travel with the submission, are shown to Vendora in the workflow panel and on
// the review page, never back to the counterparty; the seller's notification carries both; and the
// comparison step can take a document already with the record instead of a fresh upload.
const {test,after}=require('node:test');const assert=require('node:assert/strict');
const fs=require('fs');const path=require('path');const crypto=require('crypto');
const seeds=require('./fixtures/workflow-seeds.json');
const url=process.env.TEST_DATABASE_URL;
if(url&&!/\/agreement_test(?:\?|$)/.test(url))throw new Error('Only the disposable agreement_test database is allowed.');
const chrome=[process.env.CHROME_BIN,'/usr/bin/chromium','/usr/bin/google-chrome'].find(p=>p&&fs.existsSync(p));
const FIXTURE=path.join(__dirname,'fixtures','counterparty-comments.txt');
const MGMT={label:'General Management / Authorised Signatory',p:{n:'Ryan Example',e:'ryan@counterparty.example.test',p:'',t:''},b:{}};
const enc=o=>Buffer.from(JSON.stringify(o),'utf8').toString('base64');

let shared=null;
async function boot(){
  Object.assign(process.env,{DATABASE_URL:url,NODE_ENV:'test',SIGNER_EMAIL:'signer@vendora.se',ADMIN_EMAILS:'owner@vendora.se,signer@vendora.se',SMTP_USER:'test@example.test',SMTP_PASS:'mock',GOOGLE_SERVICE_ACCOUNT_JSON:'',ANTHROPIC_API_KEY:'',AGREEMENT_WEBHOOK_URL:''});
  const db=require('../db');await db.init();
  const nodemailer=require('nodemailer');const mail=[];
  nodemailer.createTransport=()=>({sendMail:async m=>{mail.push(m);return {messageId:'test-message'};}});
  const ai=require('../ai');ai.enabled=true;   // the comparison card is rendered only when the Contract Lawyer is available
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
const upload=(base,id,token,name,body,company='Example Supplier Ltd')=>fetch(base+'/api/agreements/'+id+'/counterparty-files?token='+encodeURIComponent(token),{method:'POST',headers:{'Content-Type':'text/plain','X-Filename':encodeURIComponent(name),'X-Uploader-Name':encodeURIComponent(company)},body});

test('browser: the counterparty attaches their document and comments, and Vendora finds both',{skip:!url?'TEST_DATABASE_URL not set':!chrome?'Chrome unavailable':false,timeout:180000},async()=>{
  const t=await ctx();const {good,ids,mail}=t;let browser;
  try{
    const data={...seeds.da,vname:'Thomas Test',vemail:'thomas@vendora.example.test',contacts:{...(seeds.da.contacts||{}),mgmt:MGMT}};
    const id=(await good('/api/agreements','POST',{type:'da',data,status:'draft',counterpartyName:data.name})).id;ids.push(id);
    await good('/api/workflow/'+id+'/start','POST',{});
    const view=await good('/api/workflow/'+id);
    const invited=await good('/api/workflow/'+id+'/invite','POST',{email:'ryan@counterparty.example.test',expectedRevision:view.revision,requestId:crypto.randomUUID()});
    const link=invited.inviteUrl.replace(/^https:\/\/[^/]+/,t.base);
    const carried=JSON.parse(Buffer.from(link.split('#fill=')[1],'base64').toString('utf8'));
    const comments='Clause 3: ninety (90) days\' notice please.\nClause 5: 30 days net.';

    const puppeteer=require('puppeteer-core');browser=await puppeteer.launch({executablePath:chrome,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
    const page=await browser.newPage();page.setDefaultTimeout(30000);const pageErrors=[],dialogs=[];
    page.on('pageerror',e=>pageErrors.push(e.message));page.on('dialog',async d=>{dialogs.push(d.message());await d.dismiss();});
    await page.setRequestInterception(true);page.on('request',r=>{/^https?:\/\/127\.0\.0\.1/.test(r.url())?r.continue():r.abort();});
    await page.setViewport({width:1200,height:1800});

    // 1. The fill-in page: company details, comments on the wording, and their own document attached.
    await page.goto(link,{waitUntil:'networkidle0'});await page.waitForSelector('#fillMarkupCard');
    for(const [sel,val] of [['#fill_name','Example Supplier Ltd'],['#fill_reg','12345678'],['#fill_country','United Kingdom'],['#fill_addr','1 Example Street'],['#fill_products','Bags and luggage']]){await page.click(sel,{clickCount:3});await page.type(sel,val);}
    await page.type('#fill_comments',comments);
    await (await page.$('#fill_file')).uploadFile(FIXTURE);
    const mailsBefore=mail.length;
    await page.evaluate(()=>doSubmitFill());
    await page.waitForSelector('#thankModal.open');
    assert.deepEqual(dialogs,[]);

    // 2. With the record: the file among the agreement's files, the comments in the data, both in the seller's mail.
    const files=(await good('/api/agreements/'+id+'/files')).files;
    assert.equal(files.length,1);assert.equal(files[0].filename,'counterparty-comments.txt');assert.equal(files[0].uploaded_by,'Example Supplier Ltd (counterparty)');
    const rec=(await good('/api/agreements/'+id)).agreement;
    assert.equal(rec.status,'submitted');assert.equal(rec.data._counterpartyComments,comments);
    const notice=mail.slice(mailsBefore).find(m=>/details submitted/.test(m.subject));
    assert.ok(notice,'the seller is notified');
    assert.match(notice.html,/Their comments on the agreement wording:/);assert.match(notice.html,/ninety \(90\) days&#39; notice please\./);
    assert.match(notice.html,/They attached <strong>counterparty-comments\.txt<\/strong>/);
    // …and never back out to the counterparty.
    const pub=await (await fetch(t.base+'/api/public-invites/'+id+'?token='+encodeURIComponent(carried._atok)+'&version='+carried._sentVersion)).json();
    assert.equal(pub._counterpartyComments,undefined);

    // 3. The archive: the file is listed, the comparison step offers it preselected and reads it, the workflow panel shows the comments.
    await page.setCookie({name:t.auth.COOKIE,value:t.auth.signToken(t.owner),url:t.base});
    await page.goto(t.base+'/',{waitUntil:'networkidle0'});
    await page.evaluate(id=>archiveEdit(id),id);
    await page.waitForFunction(()=>/counterparty-comments\.txt/.test(document.getElementById('apFiles').textContent));
    await page.waitForFunction(()=>{var s=document.getElementById('cr_stored_da');return s&&s.style.display!=='none'&&s.value;});
    assert.match(await page.$eval('#cr_stored_da',s=>s.options[s.selectedIndex].textContent),/^counterparty-comments\.txt · Example Supplier Ltd \(counterparty\) · \d{4}-\d\d-\d\d$/);
    const stored=await page.evaluate(async()=>{const f=await crStoredFile('da');const r=await readContractFile(f);return {name:f.name,kind:r.kind,text:r.data};});
    assert.equal(stored.name,'counterparty-comments.txt');assert.equal(stored.kind,'text');assert.equal(stored.text,fs.readFileSync(FIXTURE,'utf8'));
    await page.waitForFunction(()=>/Leverantörens kommentarer om avtalstexten/.test(document.body.textContent));
    assert.match(await page.evaluate(()=>document.body.textContent),/Clause 3: ninety \(90\) days' notice please\./);
    assert.deepEqual(pageErrors,[]);

    // 4. The upload route holds its guards.
    assert.equal((await upload(t.base,id,'wrong-token','x.txt','hello')).status,403);
    assert.equal((await upload(t.base,id,carried._atok,'macro.exe','hello')).status,400);
    assert.equal((await upload(t.base,id,carried._atok,'empty.txt','')).status,400);
    let wf=await good('/api/workflow/'+id);   // their changed products text is a proposal to decide before approval
    for(const item of wf.state.items.filter(i=>i.status==='pending'))wf=await good('/api/workflow/'+id+'/decisions','POST',{itemId:item.id,action:'keep',expectedRevision:wf.revision,requestId:crypto.randomUUID()});
    await good('/api/agreements/'+id+'/send-for-signature','POST',{expectedRevision:wf.revision,summary:{terms:[],deviations:[]}});
    assert.equal((await upload(t.base,id,carried._atok,'late.txt','too late')).status,409);
    assert.equal((await good('/api/agreements/'+id+'/files')).files.length,1,'nothing else got through');
  }finally{if(browser)await browser.close();}
});

test('browser: outside the workflow the comments are stored with the submission and shown on the review page',{skip:!url?'TEST_DATABASE_URL not set':!chrome?'Chrome unavailable':false,timeout:120000},async()=>{
  const t=await ctx();const {good,ids}=t;let browser;
  try{
    const data={...seeds.ra};
    const inv=await good('/api/invites','POST',{type:'ra',data,counterpartyName:data.name,counterpartyEmail:'jane@counterparty.example.test'});ids.push(inv.id);
    const up=await upload(t.base,inv.id,inv.token,'reseller-notes.txt',fs.readFileSync(FIXTURE,'utf8'),'Example Reseller AB');
    assert.equal(up.status,200);
    const sub=await fetch(t.base+'/api/agreements/'+inv.id+'/submit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:inv.token,data:{...data,sig_name:'Jane Signer',sig_email:'jane@counterparty.example.test',_counterpartyComments:'Please add a 30-day cure period to clause 9.'},counterpartyName:data.name})});
    assert.equal(sub.status,200,await sub.text());
    const rec=(await good('/api/agreements/'+inv.id)).agreement;
    assert.equal(rec.data._counterpartyComments,'Please add a 30-day cure period to clause 9.');
    assert.equal((await good('/api/agreements/'+inv.id+'/files')).files[0].uploaded_by,'Example Reseller AB (counterparty)');
    const puppeteer=require('puppeteer-core');browser=await puppeteer.launch({executablePath:chrome,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
    const page=await browser.newPage();page.setDefaultTimeout(30000);const pageErrors=[];page.on('pageerror',e=>pageErrors.push(e.message));
    await page.setCookie({name:t.auth.COOKIE,value:t.auth.signToken(t.owner),url:t.base});
    await page.goto(t.base+'/#review='+enc({...rec.data,_type:'ra',_aid:inv.id,_review:true}),{waitUntil:'networkidle0'});
    await page.waitForSelector('#reviewComments');
    assert.match(await page.$eval('#reviewComments',e=>e.textContent),/Reseller's comments on the agreement wording.*Please add a 30-day cure period to clause 9\./s);
    assert.deepEqual(pageErrors,[]);
  }finally{if(browser)await browser.close();}
});

test('the pieces are wired in',()=>{
  const read=f=>fs.readFileSync(path.join(__dirname,'..',f),'utf8');
  const html=read('index.html'),server=read('server.js'),core=read('workflow-core.js'),ui=read('workflow-ui.js');
  assert.match(server,/app\.post\('\/api\/agreements\/:id\/counterparty-files', publicLimiter, requireDb,/);
  assert.match(server,/const MARKUP_TYPES = /);assert.match(server,/comments, attachment \} = req\.body/);
  assert.match(core,/d\._counterpartyComments=value\(/);
  assert.match(ui,/kommentarer om avtalstexten/);
  for(const m of ['markupCard.id = "fillMarkupCard"','id=\'fill_comments\'','id=\'fill_file\'','function uploadCounterpartyFile(','reviewData._counterpartyComments = comments','id="reviewComments"','function crFillStoredFiles(','function crStoredFile(','file=await crStoredFile(type)'])assert.ok(html.includes(m),m);
});

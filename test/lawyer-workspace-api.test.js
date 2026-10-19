'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const crypto=require('crypto');
const C=require('../lawyer-workspace-core');
const seeds=require('./fixtures/workflow-seeds.json');
const testUrl=process.env.TEST_DATABASE_URL;
if(testUrl && !/\/agreement_test(?:\?|$)/.test(testUrl))throw Error('Only the disposable agreement_test database is allowed.');

test('persistent lawyer workspace: archive selection, two linked drafts, memory, permissions and immutable signed parent', {skip:!testUrl?'TEST_DATABASE_URL not set':false,timeout:180000},async()=>{
  const {Pool}=require('pg');const adminPool=new Pool({connectionString:testUrl});
  const database='lawyer_workspace_'+process.pid;await adminPool.query('CREATE DATABASE '+database);
  const local=new URL(testUrl);local.pathname='/'+database;
  Object.assign(process.env,{DATABASE_URL:local.href,NODE_ENV:'test',ADMIN_EMAILS:'workspace-admin@vendora.se',SIGNER_EMAIL:'',ANTHROPIC_API_KEY:'',SMTP_USER:'',SMTP_PASS:'',GOOGLE_SERVICE_ACCOUNT_JSON:'',AGREEMENT_WEBHOOK_URL:''});
  const db=require('../db');await db.init();
  const auth=require('../auth'),ai=require('../ai');ai.enabled=true;
  const calls=[];let delayed=false,release=null;
  ai.chat=async(agreement,messages,opts)=>{
    calls.push(C.copy({agreement,messages,opts}));
    if(delayed)await new Promise(r=>{release=r;});
    const text=messages[messages.length-1].content;
    if(text==='provider-failure')throw Error('Synthetic provider failure');
    if(/question|Remember/.test(text))return {reply:'Saved synthetic answer to '+text,proposals:[],documents:[]};
    let kind=/tillägg/.test(text)?'addendum':/anslutning/.test(text)?'accession':opts.workspace.source?'appendix':'agreement';
    const ref=opts.workspace.documents[0];
    const doc={kind,title:kind==='appendix'?'Bilaga – kampanjvillkor':'Tilläggsavtal – syntetiskt test',language:'sv',effective_date:'2027-01-01',
      sections:[{heading:'1. Omfattning',paragraphs:['Detta är ett separat syntetiskt testdokument. Huvudavtalets övriga villkor lämnas oförändrade.']},
        {heading:'2. Ikraftträdande',paragraphs:['Utkastet gäller endast efter parternas uttryckliga överenskommelse. Ingen underskrift simuleras i dokumenttexten.']}],
      missing_information:/missing/.test(text)?['Bekräfta ikraftträdandedatum']:[],reference_document_ids:kind==='addendum'&&ref?[ref.id]:[],
      replaces_document_id:/rework/.test(text)&&ref?ref.id:''};
    return {reply:'Ett separat utkast är klart för granskning.',proposals:[],documents:[doc]};
  };
  const app=require('../server');const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const base='http://127.0.0.1:'+server.address().port;
  const makeUser=async(email,name)=>(await db.query('INSERT INTO users(email,name,onboarded_at) VALUES($1,$2,now()) RETURNING *',[email,name])).rows[0];
  const owner=await makeUser('workspace-owner@vendora.se','Workspace Test'),other=await makeUser('workspace-other@vendora.se','Other Test'),admin=await makeUser('workspace-admin@vendora.se','Admin Test');
  async function request(p,method='GET',body,user=owner){
    const r=await fetch(base+p,{method,headers:{...(user?{Cookie:auth.COOKIE+'='+auth.signToken(user)}:{}),...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined});
    return {status:r.status,body:await r.json()};
  }
  async function good(p,method,body,user){const r=await request(p,method,body,user);assert.equal(r.status,200,JSON.stringify(r.body));return r.body;}
  const parent=(await db.query(`INSERT INTO agreements(type,counterparty_name,data,status,created_by,created_by_name,vendora_signed_at,workflow_revision,created_at)
    VALUES('ra','Komplett – workspace test',$1,'signed',$2,'Workspace Test',now(),7,now()-interval '2 days') RETURNING *`,[{...seeds.ra,name:'Komplett – workspace test',_vendoraSignature:{name:'Synthetic prior approval'}},owner.id])).rows[0];
  const original=C.copy(parent);
  for(let i=0;i<12;i++)await db.query("INSERT INTO agreements(type,counterparty_name,data,created_by) VALUES('ra',$1,$2,$3)",['Recent '+i,seeds.ra,owner.id]);
  const forbidden=(await db.query("INSERT INTO agreements(type,counterparty_name,data,created_by) VALUES('ra','Private counterparty',$1,$2) RETURNING id",[seeds.ra,other.id])).rows[0].id;
  const da=(await db.query("INSERT INTO agreements(type,counterparty_name,data,created_by) VALUES('da','Restricted supplier',$1,$2) RETURNING id",[seeds.da,owner.id])).rows[0].id;
  let browser;
  try{
    const recent=await good('/api/lawyer/recent');assert.equal(recent.agreements.length,10);assert.ok(recent.agreements.every(a=>a.type==='ra'&&a.id!==forbidden));assert.ok(!recent.agreements.some(a=>a.id===parent.id),'older agreements remain accessible by archive, not deleted');
    assert.equal((await request('/api/lawyer/recent','GET',undefined,null)).status,401);
    assert.equal((await request('/api/lawyer/threads','POST',{agreementId:forbidden})).status,404);
    assert.equal((await request('/api/lawyer/threads','POST',{agreementId:da})).status,404);
    assert.equal((await request('/api/lawyer/threads','POST',{agreementId:da},admin)).status,200);
    // The actual archive button opens a bound workspace, not an unrelated current form.
    const puppeteer=require('puppeteer-core');browser=await puppeteer.launch({executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
    const page=await browser.newPage();page.setDefaultTimeout(30000);const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
    await page.setViewport({width:1440,height:1080});await page.setCookie({name:auth.COOKIE,value:auth.signToken(owner),url:base});
    await page.goto(base,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>window.openLawyerWorkspace&&window.LawyerChanges);
    await page.evaluate(()=>{window._aiEnabled=true;window._archiveEnabled=true;switchTab(3);loadArchive();});
    await page.waitForSelector('[data-lawyer-agreement="'+parent.id+'"]',{visible:true});await page.click('[data-lawyer-agreement="'+parent.id+'"]');
    await page.waitForFunction(id=>window._lawyerWorkspaceView&&window._lawyerWorkspaceView.thread.agreementId===id,{},parent.id);
    let state=await page.evaluate(()=>window._lawyerWorkspaceView);const tid=state.thread.id;
    assert.equal(state.thread.type,'ra');assert.equal(state.allowOriginalChanges,false);assert.equal(state.thread.source.revision,7);
    assert.equal((await good('/api/lawyer/threads','POST',{agreementId:parent.id,agreementType:'da'})).thread.id,tid,'stored source determines type, not client hint');
    assert.equal((await request('/api/lawyer/threads/'+tid,'GET',undefined,other)).status,404);
    await page.type('#lwInput','Skriv en bilaga med syntetiska kampanjvillkor.');await page.click('#lwSend');
    await page.waitForFunction(()=>window._lawyerWorkspaceView.documents.length===1);
    state=await good('/api/lawyer/threads/'+tid);const appendix=state.documents[0];
    assert.equal(appendix.agreement_id,parent.id);assert.equal(appendix.source.digest,C.sourceOf(parent).digest);assert.equal(state.thread.messages.length,2);
    assert.equal(calls[0].opts.agreementType,'ra');assert.equal(calls[0].agreement.name,parent.data.name);assert.ok(!JSON.stringify(calls[0]).includes('Private counterparty'));
    const revision=state.thread.revision;
    const first=state.thread.messages[0];await good('/api/lawyer/threads/'+tid+'/messages','POST',{message:first.content,expectedRevision:0,requestId:first.requestId,referenceIds:[]});
    assert.equal((await good('/api/lawyer/threads/'+tid)).documents.length,1,'network retry does not create another draft');
    assert.equal((await request('/api/lawyer/threads/'+tid+'/messages','POST',{message:'different',expectedRevision:revision,requestId:first.requestId})).status,409);
    // Reload and reopen from the archive. The server retains the conversation and draft.
    await page.reload({waitUntil:'domcontentloaded'});await page.evaluate(id=>openLawyerWorkspace(id),parent.id);
    await page.waitForFunction(()=>document.getElementById('lwMessages').textContent.includes('syntetiska kampanjvillkor'));
    assert.equal(await page.evaluate(()=>window._lawyerWorkspaceView.thread.id),tid);
    await page.click('[data-ref="'+appendix.id+'"]');
    await page.type('#lwInput','Skriv ett tilläggsavtal som hänvisar till den markerade bilagan.');await page.click('#lwSend');
    await page.waitForFunction(()=>window._lawyerWorkspaceView.documents.length===2);
    state=await good('/api/lawyer/threads/'+tid);const supplement=state.documents.find(d=>d.content.kind==='addendum');
    assert.equal(supplement.references_data[0].id,appendix.id);assert.equal(supplement.references_data[0].version,1);assert.equal(supplement.references_data[0].digest,appendix.content_digest);
    assert.equal(calls[1].messages[0].content,first.content);assert.equal(calls[1].opts.workspace.documents[0].id,appendix.id);
    // Word output is real; no original approval stamp or internal conversational rationale leaks.
    const exported=await page.evaluate(async doc=>{const result=await buildLawyerDraftDocx(doc);const buf=await result.blob.arrayBuffer();return {xml:await zipEntryText(buf,'word/document.xml'),bytes:Array.from(new Uint8Array(buf))};},supplement);
    assert.match(exported.xml,/UTKAST/);assert.match(exported.xml,new RegExp(appendix.document_number));assert.match(exported.xml,/kampanjvillkor/);assert.doesNotMatch(exported.xml,/Synthetic prior approval/);
    fs.mkdirSync('test-results',{recursive:true});fs.writeFileSync('test-results/lawyer-linked-addendum.docx',Buffer.from(exported.bytes));
    await page.screenshot({path:'test-results/lawyer-workspace.png',fullPage:true});
    await good('/api/lawyer/documents/'+supplement.id+'/review','POST',{status:'reviewed',expectedDigest:supplement.content_digest});
    assert.equal((await good('/api/lawyer/documents/'+supplement.id)).document.review_status,'reviewed');
    assert.equal((await request('/api/lawyer/documents/'+supplement.id,'GET',undefined,other)).status,404);
    // A new draft revision keeps the old version and the original reference intact.
    state=await good('/api/lawyer/threads/'+tid);
    await good('/api/lawyer/threads/'+tid+'/messages','POST',{message:'rework bilaga',expectedRevision:state.thread.revision,requestId:crypto.randomUUID(),referenceIds:[appendix.id]});
    state=await good('/api/lawyer/threads/'+tid);assert.equal(state.documents.length,3);
    const v2=state.documents.find(d=>d.replaces_id===appendix.id);assert.equal(v2.version,2);assert.equal(v2.document_number,appendix.document_number);
    assert.equal((await good('/api/lawyer/documents/'+supplement.id)).document.references_data[0].version,1,'references never jump to latest revision');
    assert.equal((await request('/api/lawyer/threads/'+tid,'DELETE')).status,409,'document provenance is not casually deleted with the chat');
    // More than twenty messages remain available to the model, not merely in the UI.
    for(let i=0;i<11;i++){
      state=await good('/api/lawyer/threads/'+tid);
      await good('/api/lawyer/threads/'+tid+'/messages','POST',{message:'question '+i,expectedRevision:state.thread.revision,requestId:crypto.randomUUID()});
    }
    assert.ok(calls[calls.length-1].messages.length>20);assert.equal(calls[calls.length-1].messages[0].content,first.content);
    // Actual parent contents and approval remain byte-for-byte unchanged.
    let stored=(await db.query('SELECT * FROM agreements WHERE id=$1',[parent.id])).rows[0];
    assert.deepEqual(stored.data,original.data);assert.equal(stored.status,'signed');assert.equal(stored.workflow_revision,7);assert.equal(new Date(stored.vendora_signed_at).toISOString(),new Date(original.vendora_signed_at).toISOString());
    // A single contextual type feeds the legacy chat and document verifier.
    await page.click('#lwClose');await page.evaluate(id=>archiveEdit(id),parent.id);
    await page.waitForFunction(id=>window._editing&&window._editing.id===id,{},parent.id);
    const types=await page.evaluate(()=>{syncStoredAgreementType();return {chat:document.getElementById('aiAgreementType').value,verify:document.getElementById('verifyAgreementType').value,locked:document.getElementById('aiAgreementType').disabled,hidden:document.getElementById('verifyAgreementType').parentElement.hidden && getComputedStyle(document.getElementById('verifyAgreementType').parentElement).display==='none'};});
    assert.deepEqual(types,{chat:'reseller',verify:'reseller',locked:true,hidden:true});
    await page.evaluate(()=>lwRestoreLegacyChat());assert.ok(await page.evaluate(()=>window._aiMessages.length>20));
    // The newest ten agreements are shortcuts, not an unscoped model-memory dump.
    const fresh=await good('/api/lawyer/threads','POST',{agreementType:'general',newThread:true});
    const independent=await good('/api/lawyer/threads/'+fresh.thread.id+'/messages','POST',{message:'Skriv ett nytt syntetiskt grundavtal.',expectedRevision:0,requestId:crypto.randomUUID()});
    assert.equal(independent.documents[0].agreement_id,null);assert.equal(independent.documents[0].content.kind,'agreement');
    assert.equal(calls[calls.length-1].opts.workspace.source,null);assert.equal(calls[calls.length-1].messages.length,1);
    // Reject foreign references before any AI call.
    const callCount=calls.length;
    assert.equal((await request('/api/lawyer/threads/'+fresh.thread.id+'/messages','POST',{message:'question',expectedRevision:1,requestId:crypto.randomUUID(),referenceIds:[appendix.id]})).status,404);
    assert.equal(calls.length,callCount);
    // Failed provider calls leave no half-conversation and release the lease for retry.
    state=await good('/api/lawyer/threads/'+tid);const oldRevision=state.thread.revision;
    assert.equal((await request('/api/lawyer/threads/'+tid+'/messages','POST',{message:'provider-failure',expectedRevision:oldRevision,requestId:crypto.randomUUID()})).status,500);
    state=await good('/api/lawyer/threads/'+tid);assert.equal(state.thread.revision,oldRevision);assert.equal(state.thread.busy,false);
    // One in-flight question per thread; concurrent callers cannot fork history.
    delayed=true;
    const ongoing=request('/api/lawyer/threads/'+tid+'/messages','POST',{message:'question delayed',expectedRevision:oldRevision,requestId:crypto.randomUUID()});
    for(let n=0;n<100&&!release;n++)await new Promise(r=>setTimeout(r,10));assert.ok(release);
    assert.equal((await request('/api/lawyer/threads/'+tid+'/messages','POST',{message:'question concurrent',expectedRevision:oldRevision,requestId:crypto.randomUUID()})).status,409);
    release();delayed=false;assert.equal((await ongoing).status,200);
    // A later source change is explicit; the old thread and draft versions survive.
    await db.query("UPDATE agreements SET data=jsonb_set(data,'{pay}','\"75\"') WHERE id=$1",[parent.id]);
    state=await good('/api/lawyer/threads/'+tid);assert.equal(state.thread.sourceStale,true);
    assert.equal((await request('/api/lawyer/threads/'+tid+'/messages','POST',{message:'question after source changed',expectedRevision:state.thread.revision,requestId:crypto.randomUUID()})).status,409);
    const next=await good('/api/lawyer/threads','POST',{agreementId:parent.id,newThread:true});assert.notEqual(next.thread.id,tid);assert.equal(next.thread.source.data.pay,'75');
    assert.equal((await good('/api/lawyer/documents/'+appendix.id)).sourceStale,true);
    assert.equal(errors.length,0,errors.join('\n'));
    fs.writeFileSync('test-results/lawyer-workspace-outcome.json',JSON.stringify({result:'passed',parentUntouchedBeforeStaleFixture:true,draftVersions:state.documents.length,chatMessages:state.thread.messages.length,sourceReferences:'pinned IDs + versions + hashes',recentLimit:10,ai:'mocked',mail:'not configured',realSignatures:false},null,2));
  }finally{
    if(browser)await browser.close();await new Promise(r=>server.close(r));await db.pool.end();
    await adminPool.query('DROP DATABASE '+database+' WITH (FORCE)');await adminPool.end();
  }
});

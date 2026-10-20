'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('fs');const path=require('path');
const seeds=require('./fixtures/workflow-seeds.json');const C=require('../workflow-core');
const companyFixture=require('./fixtures/counterparty-details');
const url=process.env.TEST_DATABASE_URL;
if(url&&!/\/agreement_test(?:\?|$)/.test(url))throw new Error('Only the disposable agreement_test database is allowed.');
test('Vendora-first: two real API/browser review rounds, persisted Word edits, locking and signature requests', {skip:!url?'TEST_DATABASE_URL not set':false,timeout:180000},async(t)=>{
  Object.assign(process.env,{DATABASE_URL:url,NODE_ENV:'test',SIGNER_EMAIL:'signer@vendora.se',ADMIN_EMAILS:'owner@vendora.se,signer@vendora.se',SMTP_USER:'test@example.test',SMTP_PASS:'mock',GOOGLE_SERVICE_ACCOUNT_JSON:'',ANTHROPIC_API_KEY:'',AGREEMENT_WEBHOOK_URL:''});
  const db=require('../db');await db.init();
  const nodemailer=require('nodemailer');const mail=[];let failMail=false;
  nodemailer.createTransport=()=>({sendMail:async m=>{if(failMail)throw new Error('mock mail failure');mail.push(m);return {messageId:'test-message'};}});
  const ai=require('../ai');ai.enabled=true;
  ai.reviewContract=async a=>{
    assert.equal(a.type,'ra');assert.match(a.ourText,/RESELLER AGREEMENT/);assert.match(a.ourText,/insolvency/);
    const ch=(kind,id,oldT,newT)=>({target_kind:kind,target_id:id,op:'replace',old_text:oldT,new_text:newT,label:id,rationale:'synthetic test',anchor:''});
    const findings=[
      {classification:'deal_breaker',topic:'Safe payment alternative',changes:[ch('field','pay',a.agreement.pay,'45')]},
      {classification:'negotiate',topic:'Retain full protection',changes:[ch('clause','ra.s4.title','full payment','complete payment')]},
      {classification:'red_flag',topic:'Keep our law',changes:[]},
      {classification:'acceptable',topic:'Equivalent',changes:[]},
      {classification:'negotiate',topic:'Delivery alternative',changes:[ch('field','terr',a.agreement.terr,'Sweden')]}
    ].map(f=>({...f,their_clause_ref:'test',their_position:'Synthetic request',our_position:'Vendora baseline',why_it_matters:'Test only',proposed_wording:f.changes.map(c=>c.new_text).join('\n'),legal_note:'',requires_counsel:false}));
    return {company_details:companyFixture('ra').raw,document_summary:'Synthetic counterparty comparison',governing_law_and_forum:'Swedish law',overall_verdict:'negotiate',overall_rationale:'Synthetic test',findings,questions_for_seller:[],refer_to_counsel:false,counsel_reason:''};
  };
  ai.chat=async (agreement,messages)=>({reply:'Synthetic alternative in OUR agreement',proposals:[{target_kind:'field',target_id:'pay',op:'replace',old_text:agreement.pay,new_text:'50',label:'Payment alternative',rationale:'test alternative',anchor:''}]});
  const app=require('../server'),auth=require('../auth');
  const owner=(await db.query("INSERT INTO users(email,name,onboarded_at) VALUES('owner@vendora.se','Test owner',now()) ON CONFLICT(email) DO UPDATE SET name=EXCLUDED.name RETURNING *")).rows[0];
  const signer=(await db.query("INSERT INTO users(email,name,onboarded_at) VALUES('signer@vendora.se','Test signer',now()) ON CONFLICT(email) DO UPDATE SET name=EXCLUDED.name RETURNING *")).rows[0];
  const stranger=(await db.query("INSERT INTO users(email,name,onboarded_at) VALUES('other@vendora.se','Other',now()) ON CONFLICT(email) DO UPDATE SET name=EXCLUDED.name RETURNING *")).rows[0];
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
  const cookie=u=>auth.COOKIE+'='+auth.signToken(u);let browser;let id;const extraIds=[];
  async function api(p,method='GET',body,user=owner,rawHeaders){
    const headers={...(user?{Cookie:cookie(user)}:{}),...(body?{'Content-Type':'application/json'}:{}),...rawHeaders};
    const r=await fetch(base+p,{method,headers,body:body?typeof body==='string'?body:JSON.stringify(body):undefined});let j;try{j=await r.json();}catch(_){j={};}return {status:r.status,body:j};
  }
  async function good(p,method,body,user){const r=await api(p,method,body,user);assert.equal(r.status,200,JSON.stringify(r.body));return r.body;}
  try {
    // Real frontend upload -> saved review -> direct approval cards.
    const puppeteer=require('puppeteer-core');browser=await puppeteer.launch({executablePath:process.env.CHROME_BIN||'/usr/bin/google-chrome',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
    const page=await browser.newPage();page.setDefaultTimeout(30000);const pageErrors=[];page.on('pageerror',e=>pageErrors.push(e.message));
    await page.setCookie({name:auth.COOKIE,value:auth.signToken(owner),url:base});
    await page.goto(base,{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>window.wfEnsure&&window.LawyerChanges);
    await page.evaluate(d=>{window._authUser={id:d.id,email:d.email,name:d.name,isAdmin:true};window._archiveEnabled=true;window._isAdmin=true;window._aiEnabled=true;switchTab(1);renderContractReviewCards();},owner);
    await page.evaluate(d=>hydrateForm('ra',d),seeds.ra);
    await page.evaluate(()=>sv('ra_inv_email','customer@example.test'));
    fs.mkdirSync('test-results',{recursive:true});const inputPath=path.resolve('test-results/customer-input.txt');fs.writeFileSync(inputPath,companyFixture('ra').doc.data);
    const upload=await page.$('#cr_file_ra');await upload.uploadFile(inputPath);
    await page.click('#cr_btn_ra');
    await page.waitForFunction(()=>document.querySelectorAll('#wf_panel_ra .wf-item').length===5);
    id=await page.evaluate(()=>window._editing.id);
    const initial=await good('/api/workflow/'+id);assert.equal(initial.state.items.length,5);const baseline=C.digest(initial.state.baseline);
    assert.ok(initial.signatureProblems.includes('Minst ett försäljningsställe krävs.'),'customer must still supply an approved point of sale');
    const blocked=await api('/api/agreements/'+id+'/request-signature','POST',{expectedRevision:initial.revision,summary:{terms:[],deviations:[]}});assert.equal(blocked.status,400);
    // Company details are a separate preview, not silently copied from the uploaded paper.
    const imported=initial.state.companyImports[0];assert.equal(imported.fields.length,5);
    assert.equal(initial.data.name,seeds.ra.name);assert.equal(initial.data.reg,seeds.ra.reg);
    await page.waitForSelector('[data-company="'+imported.id+'"]',{visible:true});
    assert.equal(await page.$eval('[data-company-field="name"]',e=>e.checked),false,'existing company is never preselected for overwrite');
    assert.equal(await page.$eval('[data-company-field="vat"]',e=>e.checked),true,'blank, source-verified VAT is proposed');
    const companyBody={importId:imported.id,action:'apply',fields:['name','reg','vat','addr','rcontacts.main.e'],confirmedParty:true,expectedRevision:initial.revision,requestId:'integration-company-001'};
    assert.equal((await api('/api/workflow/'+id+'/company-details','POST',{...companyBody,confirmedParty:false})).status,400);
    assert.equal((await api('/api/workflow/'+id+'/company-details','POST',{...companyBody,fields:['name','pay']})).status,400);
    assert.equal((await api('/api/workflow/'+id+'/company-details','POST',companyBody,stranger)).status,404);
    assert.equal((await good('/api/workflow/'+id)).data.name,seeds.ra.name);
    await page.evaluate(()=>document.querySelectorAll('[data-company-field]:not(:disabled)').forEach(e=>e.checked=true));
    await page.click('[data-company-confirm]');await page.click('[data-wf="company-apply"]');
    await page.waitForFunction(()=>window._editing.base.name==='Extracted Customer AB');
    let companySaved=await good('/api/workflow/'+id);
    assert.equal(companySaved.data.reg,'CP-2026-002');assert.equal(companySaved.data.vat,'CPVAT002');assert.equal(companySaved.data.addr,'Example Street 42');
    assert.equal(companySaved.data.rcontacts.main.e,'contact@customer.example.test');assert.equal(companySaved.data.pay,seeds.ra.pay);
    assert.equal(companySaved.state.companyImports[0].status,'applied');assert.equal(C.digest(companySaved.state.baseline),baseline);
    const companyDecision=companySaved.state.decisions.find(d=>d.importId===imported.id);
    const repeated=await good('/api/workflow/'+id+'/company-details','POST',{...companyBody,requestId:companyDecision.requestId,expectedRevision:initial.revision});assert.equal(repeated.revision,companySaved.revision,'retry does not duplicate a persisted approval');
    const archive=(await db.query('SELECT counterparty_name FROM agreements WHERE id=$1',[id])).rows[0];assert.equal(archive.counterparty_name,'Extracted Customer AB');
    await page.screenshot({path:'test-results/company-details-approved.png',fullPage:true});
    for(let n=0;n<5;n++){
      const action=[2,3].includes(n)?'keep':'accept';const itemId=initial.state.items[n].id;
      // A keep-only finding never had an accept button. Wait for the actual saved
      // decision and released UI, not the absence of that unrelated button.
      await page.waitForFunction(({item,action})=>{const e=document.querySelector('[data-item="'+item+'"] [data-wf="'+action+'"]');return e&&!e.disabled&&!WorkflowActivity.busy();},{},{item:itemId,action});
      await page.click('[data-item="'+itemId+'"] [data-wf="'+action+'"]');
      await page.waitForFunction(item=>{const e=document.querySelector('[data-item="'+item+'"]');return e&&!e.querySelector('[data-wf]')&&!WorkflowActivity.busy();},{},itemId);
      const savedDecision=await good('/api/workflow/'+id);
      assert.equal(savedDecision.state.items.find(item=>item.id===itemId).status,action==='keep'?'kept':'accepted');
    }
    let r=await good('/api/workflow/'+id);assert.equal(r.data.pay,'45');assert.equal(r.state.decisions.length,6);assert.equal(C.digest(r.state.baseline),baseline);
    assert.match(r.data.clauseOverrides['ra.s4.title'],/reclaim unpaid Products/);
    const amendments=C.copy(r.data.clauseOverrides);
    // Reopening uses the server state, not local approval cards.
    await page.reload({waitUntil:'domcontentloaded'});await page.evaluate(id=>wfRefresh(id),id);
    assert.equal(await page.evaluate(()=>window._editing.base.pay),'45');
    assert.equal(await page.evaluate(()=>activeTab),1,'reopening a reseller agreement selects its visible workspace');
    await page.waitForSelector('#wf_panel_ra [data-wf="invite"]',{visible:true});
    const exportData=await page.evaluate(async()=>{const d=cloneData(window._editing.base);const r=await buildRA(d);const buf=await r.blob.arrayBuffer();return {xml:await zipEntryText(buf,'word/document.xml'),bytes:Array.from(new Uint8Array(buf))};});
    assert.match(exportData.xml,/complete payment/);assert.match(exportData.xml,/reclaim unpaid Products/);assert.match(exportData.xml,/45/);assert.match(exportData.xml,/Extracted Customer AB/);assert.match(exportData.xml,/CP-2026-002/);assert.match(exportData.xml,/CPVAT002/);assert.match(exportData.xml,/Example Street 42/);assert.doesNotMatch(exportData.xml,/companyImports|sourceVerified|Källcitat/);
    fs.writeFileSync('test-results/our-agreement-after-initial-review.docx',Buffer.from(exportData.bytes));
    await page.screenshot({path:'test-results/initial-review.png',fullPage:true});
    // The same saved agreement is invited; the copy includes the approved clauses but no internals.
    await page.evaluate(()=>sv('ra_inv_email','customer@example.test'));
    await page.click('#wf_panel_ra [data-wf="invite"]');await page.waitForFunction(()=>window._editing.status==='invited');
    r=await good('/api/workflow/'+id);assert.equal(r.state.sent.delivery,'sent');assert.deepEqual(r.state.sent.data.clauseOverrides,amendments);assert.equal(r.state.sent.data.reg,'CP-2026-002');assert.equal(r.state.sent.data.companyImports,undefined);assert.equal(r.state.sent.data.redlines,undefined);
    let stored=(await db.query('SELECT * FROM agreements WHERE id=$1',[id])).rows[0];const sentVersion=stored.workflow_state.sent.version;const token=stored.update_token;
    // Public submission: factual completion succeeds, proposed terms and malicious internal fields do not overwrite content.
    const submission={...r.state.sent.data,pos_web:['customer.example.test'],pos_physical:[],name:'Completed Customer AB',country:'Sweden',addr:'Testgatan 2',sig_name:'Counterparty Signer',sig_email:'signer@example.test',rcontacts:{notices:{e:'notice@example.test'}},_proposals:{pay:{original:'forged 999',proposed:'60',comment:'Please extend'}},clauseOverrides:{},_vendoraSignature:{name:'Forged'}};
    assert.equal((await api('/api/agreements/'+id+'/submit','POST',{token:'wrong',sentVersion,data:submission},null)).status,403);
    assert.equal((await api('/api/agreements/'+id+'/submit','POST',{token,sentVersion:sentVersion-1,data:submission},null)).status,409);
    await good('/api/agreements/'+id+'/submit','POST',{token,sentVersion,data:submission},null);
    r=await good('/api/workflow/'+id);assert.equal(r.data.name,'Completed Customer AB');assert.equal(r.data.pay,'45');assert.deepEqual(r.data.clauseOverrides,amendments);assert.equal(r.data._vendoraSignature,undefined);assert.equal(r.data._proposals.pay.original,'45');assert.deepEqual(r.data.pos_web,['customer.example.test']);
    assert.equal((await api('/api/workflow/'+id,'GET',undefined,stranger)).status,404);
    // Second round: rework the customer's request, then explicitly approve the new alternative.
    await page.evaluate(id=>wfRefresh(id),id);r=await good('/api/workflow/'+id);const request=r.state.items.find(i=>i.status==='pending');
    page.once('dialog',dialog=>dialog.accept('Offer 50 days while retaining our protection.'));
    await page.click('[data-item="'+request.id+'"] [data-wf="rework"]');
    await page.waitForFunction(()=>!WorkflowActivity.busy()&&document.querySelector('[data-item^="alternative:"] [data-wf="accept"]'));
    await page.screenshot({path:'test-results/workflow-reworked-proposal.png',fullPage:true});
    await page.evaluate(id=>wfRefresh(id),id);r=await good('/api/workflow/'+id);const alternative=r.state.items.find(i=>i.status==='pending');assert.equal(r.data.pay,'45');
    await page.click('[data-item="'+alternative.id+'"] [data-wf="accept"]');await page.waitForFunction(()=>window._editing.base.pay==='50');
    r=await good('/api/workflow/'+id);assert.equal(r.data.pay,'50');assert.deepEqual(r.data.clauseOverrides,amendments);assert.equal(r.signatureProblems.length,0,JSON.stringify(r.signatureProblems));
    // A concurrent save cannot overwrite an acknowledged decision.
    assert.equal((await api('/api/agreements/'+id,'PUT',{data:r.data,expectedRevision:r.revision-1})).status,409);
    // No configured real mail is used. Test both failure reporting and a real server signature lock.
    failMail=true;const sent=await good('/api/agreements/'+id+'/request-signature','POST',{expectedRevision:r.revision,summary:{terms:[],deviations:[]}});assert.equal(sent.notified,false);failMail=false;
    r=await good('/api/workflow/'+id);assert.equal(r.status,'pending_signature');assert.ok(r.summary.deviations.length>0);
    assert.equal((await api('/api/agreements/'+id,'PUT',{data:{...r.data,pay:'1'},expectedRevision:r.revision})).status,409);
    assert.equal((await api('/api/agreements/'+id+'/sign','POST',{},owner)).status,403);
    await good('/api/agreements/'+id+'/sign','POST',{},signer);
    r=await good('/api/workflow/'+id);assert.equal(r.status,'vendora_signed');assert.equal(r.data._vendoraSignature.digest,r.state.approval.digest);
    const requestMail=await good('/api/workflow/'+id+'/send-signature','POST',{expectedRevision:r.revision});assert.equal(requestMail.sent,true);assert.equal(requestMail.status,'sent');
    const published=await good('/api/public-agreements/'+id+'?token='+requestMail.state.signatureShare.token,'GET',undefined,null);assert.equal(published.data.pay,'50');assert.equal(published.data.redlines,undefined);assert.equal(published.data.workflow_state,undefined);
    assert.equal((await api('/api/workflow/'+id+'/confirm-countersign','POST',{confirmed:true,fileId:999999,expectedRevision:requestMail.revision})).status,400);
    await page.evaluate(id=>wfRefresh(id),id);
    const finalExport=await page.evaluate(async()=>{const d=cloneData(window._editing.base);const result=await buildRA(d);const buf=await result.blob.arrayBuffer();return {xml:await zipEntryText(buf,'word/document.xml'),bytes:Array.from(new Uint8Array(buf))};});assert.match(finalExport.xml,/50/);assert.match(finalExport.xml,/complete payment/);assert.match(finalExport.xml,/customer.example.test/);fs.writeFileSync('test-results/final-agreement-synthetic.docx',Buffer.from(finalExport.bytes));
    const doc=Buffer.from(finalExport.bytes);const uploadResponse=await fetch(base+'/api/agreements/'+id+'/files',{method:'POST',headers:{Cookie:cookie(owner),'Content-Type':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','X-Filename':'synthetic-countersigned-copy.docx'},body:doc});const fileResult=await uploadResponse.json();assert.equal(uploadResponse.status,200,JSON.stringify(fileResult));assert.equal(fileResult.status,'sent');
    r=await good('/api/workflow/'+id);await good('/api/workflow/'+id+'/confirm-countersign','POST',{confirmed:true,fileId:fileResult.file.id,expectedRevision:r.revision});
    r=await good('/api/workflow/'+id);assert.equal(r.status,'signed');assert.equal(r.state.counterpartySignature.verification,'manual');
    const history=await good('/api/workflow/'+id+'/versions');assert.ok(history.versions.length>=16);
    assert.equal(pageErrors.length,0,pageErrors.join('\n'));assert.ok(mail.length>=3);
    // Both other templates use the same real review/import API and actual Word export.
    for(const type of ['rb','da'])await t.test('company detail import and Word output for '+type,async()=>{
      const f=companyFixture(type),data=C.copy(seeds[type]);
      const made=await good('/api/agreements','POST',{type,data,status:'draft',counterpartyName:data.name});extraIds.push(made.id);
      let detailRow=await good('/api/workflow/'+made.id+'/start','POST',{});
      const oldAI=ai.reviewContract;
      ai.reviewContract=async args=>{assert.equal(args.type,type);return {company_details:f.raw,findings:[],questions_for_seller:[],overall_verdict:'negotiate',document_summary:'Synthetic company only'};};
      try {
        const request=await api('/api/ai/review','POST',JSON.stringify({type,doc:f.doc,ourText:C.benchmark(data),agreementId:made.id,expectedRevision:detailRow.revision}),owner,{'Content-Type':'text/plain'});assert.equal(request.status,200,JSON.stringify(request.body));
        let result;
        for(let n=0;n<100;n++){result=await good('/api/ai/review/'+request.body.jobId);if(result.status!=='running')break;await new Promise(r=>setTimeout(r,50));}
        assert.equal(result.status,'done',JSON.stringify(result));
        detailRow=await good('/api/workflow/'+made.id);const extraction=detailRow.state.companyImports[0];
        const blockedInvite=await api('/api/workflow/'+made.id+'/invite','POST',{email:'no-send@example.test',expectedRevision:detailRow.revision,requestId:'not-ready-company'});assert.equal(blockedInvite.status,409);
        detailRow=await good('/api/workflow/'+made.id+'/company-details','POST',{importId:extraction.id,action:'apply',fields:extraction.fields.map(x=>x.field),confirmedParty:true,expectedRevision:detailRow.revision,requestId:'company-other-'+type});
        assert.equal(detailRow.data.name,f.raw.party_name);assert.equal(detailRow.data.reg,'CP-2026-002');assert.equal(detailRow.data.pay,data.pay);assert.equal(detailRow.data.invmail,data.invmail);
        const out=await page.evaluate(async row=>{const result=await (row.type==='da'?buildDA:buildRB)(cloneData(row.data));const b=await result.blob.arrayBuffer();return {xml:await zipEntryText(b,'word/document.xml'),bytes:Array.from(new Uint8Array(b))};},detailRow);
        assert.match(out.xml,/CP-2026-002/);assert.match(out.xml,/CPVAT002/);assert.match(out.xml,/Example Street 42/);assert.ok(out.xml.includes(f.raw.party_name));
        if(type==='da'){assert.match(out.xml,/invoice@vendora.se/);assert.match(out.xml,/finance@supplier.example.test/);assert.match(out.xml,/CPEORI002/);}
        fs.writeFileSync('test-results/company-import-'+type+'.docx',Buffer.from(out.bytes));
      } finally {ai.reviewContract=oldAI;}
    });
    await t.test('rework API preserves original on empty replies, rejects duplicate calls and returns an approvable alternative',async()=>{
      const data=C.copy(seeds.ra);
      const made=await good('/api/agreements','POST',{type:'ra',data,status:'draft',counterpartyName:data.name});extraIds.push(made.id);
      let entry=await good('/api/workflow/'+made.id+'/start','POST',{});
      const source={data:entry.data,type:'ra',status:'draft',workflow_state:entry.state,workflow_revision:entry.revision};
      const pending=C.recordReview(source,999,[{topic:'Payment',classification:'deal_breaker',changes:[],requires_counsel:true,proposed_wording:'Counter wording to be mapped.'}],'test');
      await db.query('UPDATE agreements SET workflow_state=$1 WHERE id=$2',[pending,made.id]);
      const payload={itemId:'review:999:0',instruction:'Offer a safe alternative.',expectedRevision:entry.revision};
      const endpoint='/api/workflow/'+made.id+'/rework',previousChat=ai.chat;
      try{
        ai.chat=async()=>({reply:'No safe change; keep our text.',proposals:[]});
        const noChange=await api(endpoint,'POST',payload);assert.equal(noChange.status,422);assert.match(noChange.body.explanation,/No safe change/);
        entry=await good('/api/workflow/'+made.id);assert.equal(entry.state.items[0].status,'pending');assert.equal(entry.revision,payload.expectedRevision);
        // Wrong actor is refused before provider work.
        assert.equal((await api(endpoint,'POST',payload,stranger)).status,404);
        let release,entered;const started=new Promise(r=>entered=r);let aiCalls=0;
        ai.chat=async (agreement,messages)=>{
          aiCalls++;assert.match(messages[0].content,/Counter wording to be mapped/);entered();
          await new Promise(r=>release=r);
          return {reply:'45 day alternative',proposals:[{target:{kind:'field',id:'pay'},op:'replace',oldText:agreement.pay,newText:'45',label:'Payment',rationale:'test',anchor:''}]};
        };
        const first=api(endpoint,'POST',payload);await started;
        let duplicate;
        try{duplicate=await api(endpoint,'POST',payload);}finally{release();}
        const result=await first;assert.equal(duplicate.status,409);assert.equal(aiCalls,1);
        assert.equal(result.status,200,JSON.stringify(result.body));assert.ok(result.body.reworkedItemId);
        assert.equal(result.body.data.pay,data.pay);assert.equal(result.body.state.items[0].status,'superseded');
        const alternative=result.body.state.items.find(i=>i.id===result.body.reworkedItemId);
        assert.equal(alternative.status,'pending');assert.equal(alternative.preview[0].newText,'45');assert.equal(alternative.requiresCounsel,true);
        const approved=await good('/api/workflow/'+made.id+'/decisions','POST',{itemId:alternative.id,action:'accept',expectedRevision:result.body.revision,requestId:'approve-real-alternative'});
        assert.equal(approved.data.pay,'45');assert.ok(approved.signatureProblems.some(p=>p.includes('särskilt godkännande')));
      }finally{ai.chat=previousChat;}
    });
    fs.writeFileSync('test-results/workflow-outcome.json',JSON.stringify({agreementId:id,status:r.status,revision:r.revision,decisions:r.state.decisions.length,versions:history.versions.length,mailMockCalls:mail.length,ai:'mocked',counterpartySignature:'synthetic file with manual confirmation'},null,2));
  }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));for(const deleted of [id,...extraIds].filter(Boolean))await db.query('DELETE FROM agreements WHERE id=$1',[deleted]);await db.pool.end();}
});

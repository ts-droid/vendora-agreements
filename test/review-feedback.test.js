'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const C=require('../workflow-core');
const seeds=require('./fixtures/workflow-seeds.json');
function row(){
  const data=C.copy(seeds.ra);
  const r={id:991,type:'ra',data,status:'draft',workflow_revision:1,workflow_state:C.createState(data)};
  r.workflow_state=C.recordReview(r,88,[{classification:'deal_breaker',topic:'Payment',why_it_matters:'Keep our terms',changes:[],requires_counsel:true}], 'test');
  return r;
}
const change={target_kind:'field',target_id:'pay',op:'replace',old_text:'30',new_text:'45',label:'Payment',rationale:'Synthetic test',anchor:''};
test('reworking a keep recommendation creates a preview but never changes the contract before approval',()=>{
  const r=row(),before=C.digest(r),result=C.reworkProposal(r,'review:88:0',{reply:'Safe alternative',proposals:[change]});
  assert.equal(C.digest(r),before);
  assert.equal(result.state.items[0].status,'superseded');
  const item=result.state.items[1];assert.equal(item.id,result.itemId);assert.equal(item.preview[0].newText,'45');assert.equal(item.proposed,'45');assert.equal(item.requiresCounsel,true);
  const approved=C.decide({...r,workflow_state:result.state},{itemId:item.id,action:'accept',expectedRevision:1,requestId:'approve-alternative-1'},'Tester','test');
  assert.equal(approved.data.pay,'45');assert.equal(r.data.pay,'30');
  assert.ok(C.signatureProblems({...r,data:approved.data,workflow_state:approved.state}).some(s=>s.includes('särskilt godkännande')));
});
test('text-only AI reply is explained and cannot discard or apply the original proposal',()=>{
  const r=row(),before=C.digest(r);
  assert.throws(()=>C.reworkProposal(r,'review:88:0',{reply:'Behåll vår lydelse. Ingen säker kompromiss.',proposals:[]}),e=>e.status===422&&e.explanation.includes('Ingen säker kompromiss'));
  assert.equal(C.digest(r),before);
});
test('a rework with mismatched target text stays blocked without partially superseding the item',()=>{
  const r=row(),before=C.digest(r);
  assert.throws(()=>C.reworkProposal(r,'review:88:0',{reply:'bad',proposals:[{...change,old_text:'missing'}]}));assert.equal(C.digest(r),before);
});
test('an identical rework is not presented as a new amendment',()=>{
  assert.throws(()=>C.reworkProposal(row(),'review:88:0',{reply:'same',proposals:[{...change,new_text:'30'}]}),/identiskt/);
});
test('rework supports the canonical format returned by the real chat adapter',()=>{
  const proposed={target:{kind:'field',id:'pay'},op:'replace',oldText:'30',newText:'45',label:'Payment',rationale:'test',anchor:''};
  assert.equal(C.reworkProposal(row(),'review:88:0',{reply:'Alternative',proposals:[proposed]}).state.items.at(-1).preview[0].newText,'45');
});
test('signed, pending, invited and actively reviewed contracts cannot be reworked',()=>{
  for(const status of ['pending_signature','vendora_signed','signed','sent','invited'])assert.throws(()=>C.reworkProposal({...row(),status},'review:88:0',{proposals:[change]}));
  const r=row();r.workflow_state.reviewRunning={jobId:'running'};assert.throws(()=>C.reworkProposal(r,'review:88:0',{proposals:[change]}));
});
test('a decided item cannot be superseded by a late AI response',()=>{
  const r=row();r.workflow_state.items[0].status='kept';assert.throws(()=>C.reworkProposal(r,'review:88:0',{proposals:[change]}));
});
test('comparison instructions distinguish applicable wording from keeping existing terms',()=>{
  const material=require('../ai').reviewContextText({type:'da',includeTask:true});assert.match(material,/matching, applicable edits/);assert.match(material,/Do not invent an unnecessary amendment/);
});

const chrome=[process.env.CHROME_BIN,'/usr/bin/chromium','/usr/bin/google-chrome'].find(p=>p&&fs.existsSync(p));
test('browser: visible progress, local rework errors, explicit keep decisions and approvable alternatives', {skip:!chrome?'Chrome unavailable':false,timeout:60000},async()=>{
  const puppeteer=require('puppeteer-core');
  const browser=await puppeteer.launch({executablePath:chrome,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  const page=await browser.newPage();const pageErrors=[];page.on('pageerror',e=>pageErrors.push(e.message));page.setDefaultTimeout(10000);
  try{
    await page.setViewport({width:1200,height:1000});
    await page.setContent('<html><head><style>body{font-family:Arial,sans-serif;background:#f2eee6;--navy:#173e32;--border:#d9dedb;--muted:#515b56;margin:30px auto;max-width:900px}.card{padding:22px;background:white;border-radius:12px;margin-top:14px}button{border:1px solid #aaa;border-radius:18px;padding:8px 12px}button:disabled{opacity:.4}.genbar{position:sticky;bottom:0;background:white;padding:14px;z-index:100}</style></head><body><div id="editBar"><span id="editBarText"></span><span id="editBarStatus"></span><button id="editSaveBtn">Save</button></div><select id="aiAgreementType"><option>reseller</option></select><div id="cr_slot_ra"><div class="card"><input id="cr_type_ra" value="reseller" type="hidden"><input id="cr_name_ra"><input type="file" id="cr_file_ra"><button id="cr_btn_ra">Jämför och föreslå anpassningar</button><div id="cr_msg_ra"></div><div id="cr_out_ra"></div></div></div><div class="genbar"><button>Generate</button></div></body></html>');
    const base=row();
    const view={id:base.id,type:base.type,data:base.data,status:base.status,revision:1,state:base.workflow_state,signatureProblems:['Saknad uppgift: sig_email']};
    view.state.items.push({...view.state.items[0],id:'unmapped',proposed:'Draft wording not yet mapped',requiresCounsel:false});
    view.state.items.push({...view.state.items[0],id:'valid',topic:'Safe alternative',changes:[change],preview:C.apply(base.data,[change]).displayed});
    view.state.items.push({...view.state.items[0],id:'invalid',topic:'Bad target',changes:[change],preview:[],issue:'Texten matchar inte längre.',proposed:'Unmapped text'});
    await page.evaluate(v=>{
      window.testRow=v;window.form=structuredClone(v.data);window.calls=[];let seq=0;
      if(!crypto.randomUUID)Object.defineProperty(crypto,'randomUUID',{value:()=>('browser-test-'+(++seq))});
      window.esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      window.redlineHtml=(a,b)=>'<del>'+esc(a)+'</del> <ins>'+esc(b)+'</ins>';
      window._authUser={id:1,name:'Tester'};window._archiveEnabled=true;window._isAdmin=true;
      window.switchTab=()=>{};window.hydrateForm=(t,d)=>{window.form=structuredClone(d);};window.readForm=()=>structuredClone(form);
      window.gv=()=>'';window.getAiContext=()=>form;window.familyFromSelect=()=> 'reseller';window.templateTypeFor=()=> 'ra';
      window.UploadLimits={MAX_FILE_BYTES:50*1024*1024};window.readContractFile=async f=>({kind:'text',data:await f.text(),filename:f.name});window.buildOurAgreementText=async()=> 'Synthetic benchmark';window.renderContractReview=()=>{};
      window.prompt=()=> 'Please draft an alternative.';
      const response=(body,ok=true)=>({ok,json:async()=>structuredClone(body)});
      window.fetch=async(url,opts={})=>{
        window.calls.push({url,method:opts.method||'GET'});
        if(url==='/api/workflow/991')return response(testRow);
        if(url==='/api/workflow/991/start')return response(testRow);
        if(url==='/api/agreements/991'){
          if(window.delaySave)await new Promise(resolve=>window.resolveSave=resolve);
          return response({id:991,revision:testRow.revision,data:testRow.data});
        }
        if(url==='/api/workflow/991/rework')return new Promise(resolve=>window.resolveRework=(body,ok=true)=>resolve(response(body,ok)));
        if(url==='/api/workflow/991/decisions'){
          const b=JSON.parse(opts.body);const item=testRow.state.items.find(i=>i.id===b.itemId);item.status=b.action==='accept'?'accepted':'kept';if(b.action==='accept')testRow.data.pay='45';testRow.revision++;return response(testRow);
        }
        if(url==='/api/ai/review'){testRow.state.reviewRunning={jobId:'job'};return response({jobId:'job'});}
        if(url==='/api/ai/review/job'){
          if(!window.completeReview)return response({status:'running'});
          testRow.state.reviewRunning=null;return response({status:'done',reviewId:90,review:{findings:[]},name:'Synthetic',created_at:new Date().toISOString()});
        }
        throw Error('Unexpected URL '+url);
      };
    },view);
    await page.addScriptTag({content:fs.readFileSync(path.join(__dirname,'../workflow-ui.js'),'utf8')});
    const html=fs.readFileSync(path.join(__dirname,'../index.html'),'utf8');
    await page.addScriptTag({content:html.slice(html.indexOf('async function runContractReview(type){'),html.indexOf('\nfunction crBadge'))});
    await page.evaluate(()=>wfRefresh(991));
    assert.equal(await page.$eval('.genbar',e=>getComputedStyle(e).position),'static','legacy export bar cannot cover review actions');
    assert.equal(await page.$('[data-item="review:88:0"] [data-wf="accept"]'),null);
    assert.match(await page.$eval('[data-item="review:88:0"] [data-wf="keep"]',e=>e.textContent),/Godkänn att vår lydelse behålls/);
    assert.match(await page.$eval('[data-item="unmapped"]',e=>e.textContent),/Draft wording not yet mapped/);
    assert.equal(await page.$('[data-item="unmapped"] [data-wf="accept"]'),null);
    assert.equal(await page.$eval('[data-item="valid"] [data-wf="accept"]',e=>e.disabled),false);
    assert.match(await page.$eval('[data-item="valid"]',e=>e.textContent),/Ny lydelse som godkänns/);
    assert.equal(await page.$('[data-item="invalid"] [data-wf="accept"]'),null);
    assert.match(await page.$eval('[data-item="invalid"]',e=>e.textContent),/Texten matchar/);
    // Real user click, delayed provider response. Status stays beside the item on re-render.
    await page.click('[data-item="review:88:0"] [data-wf="rework"]');
    await page.waitForFunction(()=>!!window.resolveRework);
    await page.waitForSelector('[data-item="review:88:0"] .wf-spinner');
    assert.equal(await page.$eval('[data-item="valid"] [data-wf="accept"]',e=>e.disabled),true);
    await page.evaluate(()=>wfRefresh(991));
    await page.waitForSelector('[data-item="review:88:0"] .wf-spinner');
    await page.waitForFunction(()=>document.querySelector('.wf-elapsed')?.textContent.includes('0:01'));
    await page.evaluate(()=>document.querySelector('[data-item="review:88:0"] [data-wf="rework"]').onclick());
    assert.equal(await page.evaluate(()=>calls.filter(c=>c.url.endsWith('/rework')).length),1);
    fs.mkdirSync('test-results',{recursive:true});await page.screenshot({path:'test-results/rework-progress.png',fullPage:true});
    await page.evaluate(()=>resolveRework({error:'Ingen tillämpbar textändring.',explanation:'Behåll vår lydelse; precisera önskemålet.'},false));
    await page.waitForFunction(()=>!WorkflowActivity.busy());
    assert.match(await page.$eval('[data-item="review:88:0"] .wf-item-feedback',e=>e.textContent),/precisera önskemålet/);
    assert.equal(await page.$eval('[data-item="valid"] [data-wf="accept"]',e=>e.disabled),false);
    assert.equal(await page.$('[data-item="invalid"] [data-wf="accept"]'),null);
    // Next valid response is previewed and focused; approval is a separate operation.
    await page.evaluate(()=>{window.resolveRework=null;});await page.click('[data-item="review:88:0"] [data-wf="rework"]');
    await page.waitForFunction(()=>!!window.resolveRework);
    await page.evaluate(()=>{
      testRow.state.items[0].status='superseded';
      const next=structuredClone(testRow.state.items.find(i=>i.id==='valid'));next.id='alternative:new';next.source='alternative';testRow.state.items.push(next);testRow.revision++;
      resolveRework({...testRow,reworkedItemId:next.id});
    });
    await page.waitForFunction(()=>!WorkflowActivity.busy());
    assert.equal(await page.evaluate(()=>document.activeElement.dataset.item),'alternative:new');
    assert.equal(await page.evaluate(()=>testRow.data.pay),'30');
    await page.screenshot({path:'test-results/rework-approvable.png',fullPage:true});
    await page.click('[data-item="alternative:new"] [data-wf="accept"]');await page.waitForFunction(()=>!WorkflowActivity.busy());
    assert.equal(await page.evaluate(()=>testRow.data.pay),'45');
    // Comparison feedback exists before save finishes; duplicate calls are ignored.
    await page.evaluate(()=>{
      testRow.state.items=[];window.delaySave=true;
      const dt=new DataTransfer();dt.items.add(new File(['Synthetic contract source for progress testing. No customer information.'],'test.txt',{type:'text/plain'}));document.getElementById('cr_file_ra').files=dt.files;
      window.reviewDone=runContractReview('ra');
    });
    await page.waitForSelector('#cr_msg_ra .wf-spinner');
    assert.match(await page.$eval('#cr_msg_ra',e=>e.textContent),/Sparar avtalsutkastet/);
    await page.evaluate(()=>runContractReview('ra'));
    const count=await page.evaluate(()=>calls.filter(c=>c.url==='/api/ai/review').length);assert.equal(count,0);
    await page.evaluate(()=>{window.delaySave=false;resolveSave();});
    await page.waitForFunction(()=>calls.some(c=>c.url==='/api/ai/review'));
    await page.waitForFunction(()=>document.getElementById('wf_panel_ra').textContent.includes('Inväntar granskningsresultat'));
    assert.equal(await page.$eval('[data-wf="invite"]',e=>e.disabled),true);
    await page.screenshot({path:'test-results/review-progress.png',fullPage:true});
    await page.evaluate(()=>{window.completeReview=true;});
    await page.evaluate(()=>window.reviewDone);
    assert.equal(await page.$('#cr_msg_ra .wf-spinner'),null);
    assert.match(await page.$eval('#cr_msg_ra',e=>e.textContent),/klar och sparad/);
    assert.equal(await page.$eval('#cr_btn_ra',e=>e.disabled),false);
    assert.equal(await page.evaluate(()=>calls.filter(c=>c.url==='/api/ai/review').length),1);
    // Reduced-motion setting removes rotation, not visible text feedback.
    await page.emulateMediaFeatures([{name:'prefers-reduced-motion',value:'reduce'}]);
    const animation=await page.evaluate(()=>{const a=WorkflowActivity.start('test',()=>document.getElementById('cr_msg_ra'),'Test');const name=getComputedStyle(document.querySelector('#cr_msg_ra .wf-spinner')).animationName;a.finish('Done');return name;});assert.equal(animation,'none');
    await page.evaluate(()=>wfReset());
    assert.equal(await page.$eval('.genbar',e=>getComputedStyle(e).position),'sticky','standalone generator retains its toolbar');
    assert.deepEqual(pageErrors,[]);
  }finally{await browser.close();}
});

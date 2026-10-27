'use strict';
// A sent customer invite is confirmed in a modal; closing it returns to the app's start page.
// A failed send keeps the manual link and never shows the confirmation.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const C=require('../workflow-core');
const seeds=require('./fixtures/workflow-seeds.json');
const chrome=[process.env.CHROME_BIN,'/usr/bin/chromium','/usr/bin/google-chrome'].find(p=>p&&fs.existsSync(p));

test('browser: sent invite shows a confirmation and closing it goes to the start page', {skip:!chrome?'Chrome unavailable':false,timeout:60000},async()=>{
  const puppeteer=require('puppeteer-core');
  const browser=await puppeteer.launch({executablePath:chrome,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
  const page=await browser.newPage();const pageErrors=[];page.on('pageerror',e=>pageErrors.push(e.message));page.setDefaultTimeout(10000);
  try{
    await page.setViewport({width:1200,height:900});
    await page.setContent('<html><head></head><body><div class="tab-panel"><div id="cr_slot_ra"></div></div></body></html>');
    const data=C.copy(seeds.ra);data.name='Testkund AB';
    const view={id:991,type:'ra',data,status:'draft',revision:1,state:C.createState(data),signatureProblems:[]};
    await page.evaluate(v=>{
      window.testRow=v;window.form=structuredClone(v.data);window.calls=[];window.sendResult=true;window.startVisits=0;let seq=0;
      if(!crypto.randomUUID)Object.defineProperty(crypto,'randomUUID',{value:()=>('browser-test-'+(++seq))});
      window.esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      window.redlineHtml=(a,b)=>'<del>'+esc(a)+'</del> <ins>'+esc(b)+'</ins>';
      window._authUser={id:1,name:'Tester'};window._archiveEnabled=true;window._isAdmin=true;
      window.switchTab=()=>{};window.hydrateForm=(t,d)=>{window.form=structuredClone(d);};window.readForm=()=>structuredClone(form);
      window.gv=()=>'';window.prompt=()=> 'kund@example.com';
      const response=(body,ok=true)=>({ok,json:async()=>structuredClone(body)});
      window.fetch=async(url,opts={})=>{
        window.calls.push({url,method:opts.method||'GET',body:opts.body?JSON.parse(opts.body):null});
        if(url==='/api/workflow/991')return response(testRow);
        if(url==='/api/workflow/991/start')return response(testRow);
        if(url==='/api/agreements/991')return response({id:991,revision:testRow.revision,data:testRow.data});
        if(url==='/api/workflow/991/invite'){
          const sent=window.sendResult;
          if(sent){testRow.status='invited';testRow.revision++;testRow.state.sent={version:testRow.revision,email:JSON.parse(opts.body).email,delivery:'sent'};}
          return response({...testRow,sent,inviteUrl:'https://example.test/#fill=abc',replayed:false});
        }
        throw Error('Unexpected URL '+url);
      };
    },view);
    await page.addScriptTag({content:fs.readFileSync(path.join(__dirname,'../workflow-ui.js'),'utf8')});
    await page.evaluate(()=>{window.wfGoToStart=()=>{window.startVisits++;};});
    await page.evaluate(()=>wfRefresh(991));
    await page.waitForSelector('[data-wf="invite"]:not([disabled])');

    // 1. Sent: the confirmation names the recipient; the button returns to the start page.
    await page.click('[data-wf="invite"]');
    await page.waitForSelector('dialog.wf-sent-dialog[open]');
    const text=await page.$eval('dialog.wf-sent-dialog',e=>e.textContent);
    assert.match(text,/Inbjudan har skickats/);assert.match(text,/kund@example\.com/);assert.match(text,/Testkund AB/);
    assert.equal(await page.evaluate(()=>document.activeElement&&document.activeElement.hasAttribute('data-sent-close')),true);
    assert.equal(await page.evaluate(()=>window.startVisits),0);
    await page.click('[data-sent-close]');
    await page.waitForFunction(()=>window.startVisits===1);
    assert.equal(await page.$('dialog.wf-sent-dialog'),null);
    assert.equal(await page.$eval('#wf_message',e=>e.textContent),'Avtalet med godkända anpassningar har skickats till kunden.');

    // 2. Escape closes the confirmation and still returns to the start page.
    await page.waitForFunction(()=>!WorkflowActivity.busy());
    await page.click('[data-wf="invite"]');
    await page.waitForSelector('dialog.wf-sent-dialog[open]');
    await page.keyboard.press('Escape');
    await page.waitForFunction(()=>window.startVisits===2);
    assert.equal(await page.$('dialog.wf-sent-dialog'),null);

    // 3. Not sent: no confirmation, the manual link stays visible, nobody is sent away.
    await page.evaluate(()=>{window.sendResult=false;});
    await page.click('[data-wf="invite"]');
    await page.waitForFunction(()=>document.getElementById('wf_message').textContent.includes('kunde inte skickas'));
    assert.equal(await page.$('dialog.wf-sent-dialog'),null);
    assert.equal(await page.$eval('#wf_message a',e=>e.getAttribute('href')),'https://example.test/#fill=abc');
    assert.equal(await page.evaluate(()=>window.startVisits),2);

    const invites=await page.evaluate(()=>window.calls.filter(c=>c.url==='/api/workflow/991/invite'));
    assert.equal(invites.length,3);invites.forEach(c=>assert.equal(c.body.email,'kund@example.com'));
    assert.deepEqual(pageErrors,[]);
  }finally{await browser.close();}
});

test('the real start-page handler drops the workflow hash and reloads',()=>{
  const src=fs.readFileSync(path.join(__dirname,'../workflow-ui.js'),'utf8');
  assert.match(src,/function goToStart\(\)\{history\.replaceState\(null,'',location\.pathname\+location\.search\);location\.reload\(\);\}/);
  assert.match(src,/if\(result\.sent\)\{await inviteSentDialog\(email,result\.data&&result\.data\.name\);window\.wfGoToStart\(\);\}/);
});

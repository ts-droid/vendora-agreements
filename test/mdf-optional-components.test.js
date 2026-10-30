'use strict';
// Base MDF is the component Vendora actually agrees; the target bonus and the co-op fund are
// options nobody has used. Yet the counterparty's fill-in page offered "Co-op fund (%) — —" as a
// term to negotiate, and Appendix 1 printed "Co-op fund — Not agreed": one supplier put their MDF
// in the co-op row by mistake (Troubadour, October 2026). The optional components now appear on
// the counterparty's page and in the document only when Vendora has set them.
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('fs');const path=require('path');
const seeds=require('./fixtures/workflow-seeds.json');
const chrome=[process.env.CHROME_BIN,'/usr/bin/chromium','/usr/bin/google-chrome'].find(p=>p&&fs.existsSync(p));

test('browser: optional MDF components are offered and printed only when set',{skip:!chrome?'Chrome unavailable':false,timeout:120000},async()=>{
  Object.assign(process.env,{DATABASE_URL:'',NODE_ENV:'test',ANTHROPIC_API_KEY:'',GOOGLE_SERVICE_ACCOUNT_JSON:'',SMTP_USER:'',SMTP_PASS:''});
  const app=require('../server');
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
  let browser;
  try{
    const puppeteer=require('puppeteer-core');browser=await puppeteer.launch({executablePath:chrome,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
    const page=await browser.newPage();page.setDefaultTimeout(30000);const pageErrors=[];page.on('pageerror',e=>pageErrors.push(e.message));
    await page.setRequestInterception(true);page.on('request',r=>{/^https?:\/\/127\.0\.0\.1/.test(r.url())?r.continue():r.abort();});
    await page.goto(base+'/',{waitUntil:'networkidle0'});
    const baseOnly={...seeds.da,_type:'da',mdfb:'3',mdft:'',mdfc:'',mdff:'Quarterly'};
    const all={...baseOnly,mdft:'1',mdfc:'1.5'};

    // The document: only agreed components in the Appendix 1 MDF table, no "Not agreed" rows.
    const docText=d=>page.evaluate(async d=>{const r=await buildDA(d);return docxToText(await r.blob.arrayBuffer());},d);
    const t1=await docText(baseOnly);
    // docxToText renders a table cell as its text, a line break and " | ".
    const row=cells=>new RegExp(cells.map(c=>c.replace(/[.%|()]/g,'\\$&')).join('\\n \\| ')+'\\n \\|');
    assert.match(t1,row(['Component','Rate','Frequency']));assert.match(t1,row(['Base MDF','3% of invoiced value','Quarterly']));
    assert.doesNotMatch(t1,/Co-op fund/);assert.doesNotMatch(t1,/Target bonus/);assert.doesNotMatch(t1,/Not agreed/);
    const t2=await docText(all);
    assert.match(t2,row(['Base MDF','3% of invoiced value','Quarterly']));assert.match(t2,row(['Target bonus','1%','Annually']));assert.match(t2,row(['Co-op fund','1.5%','As agreed']));
    assert.ok(t2.indexOf('Target bonus')<t2.indexOf('Co-op fund'),'rows keep their order');
    const t0=await docText({...baseOnly,mdfb:''});
    assert.match(t0,/No Market Development Funds have been agreed/);assert.doesNotMatch(t0,row(['Component','Rate','Frequency']));

    // The counterparty's page: the optional rows are not there to be filled in by mistake…
    const terms=d=>page.evaluate(d=>{renderFillMode(d);return Array.from(document.querySelectorAll('.neg-term')).map(e=>e.querySelector('.neg-label').textContent+' = '+e.querySelector('.neg-current').textContent.replace(/^Proposed: /,''));},d);
    const shown1=await terms(baseOnly);
    assert.ok(shown1.includes('Base MDF (%) = 3%'),shown1.join('; '));assert.ok(shown1.includes('MDF invoicing frequency = Quarterly'));
    assert.equal(shown1.some(s=>/Co-op|Target bonus/.test(s)),false,'optional components are not offered: '+shown1.join('; '));
    assert.equal(await page.evaluate(()=>Object.keys(window._negOriginals).some(k=>k==='mdfc'||k==='mdft')),false);
    // …and are, once Vendora has set them. (The fill page replaces the app's chrome, so a fresh page for the second render.)
    await page.reload({waitUntil:'networkidle0'});
    const shown2=await terms(all);
    assert.ok(shown2.includes('Target bonus MDF (%) = 1%'));assert.ok(shown2.includes('Co-op fund (%) = 1.5%'));
    assert.deepEqual(pageErrors,[]);
  }finally{if(browser)await browser.close();await new Promise(r=>server.close(r));}
});

test('the optional components are marked as such in the form',()=>{
  const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
  assert.match(html,/<label>Target bonus MDF \(%\) <em>\(optional &mdash; leave blank unless agreed\)<\/em><\/label>/);
  assert.match(html,/<label>Co-op fund \(%\) <em>\(optional &mdash; leave blank unless agreed\)<\/em><\/label>/);
  assert.match(html,/if \(isDA\) NEG_TERMS = NEG_TERMS\.filter/);
  assert.doesNotMatch(html,/"Not agreed","As agreed"/);
});

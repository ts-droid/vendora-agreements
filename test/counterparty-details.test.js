'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const vm=require('vm');
const path=require('path');
const D=require('../counterparty-details');
const C=require('../workflow-core');
const fixture=require('./fixtures/counterparty-details');
const seeds=require('./fixtures/workflow-seeds.json');
function row(type='ra'){
  const data=C.copy(seeds[type]);const r={id:1,type,data,workflow_revision:3,status:'draft',workflow_state:C.createState(data)};
  const f=fixture(type);r.workflow_state.companyImports=[D.snapshot(data,17,D.prepare(f.raw,type,f.doc))];return r;
}
function cmd(r,fields=['name','reg','vat','addr']){return {action:'apply',importId:'company:17',fields,confirmedParty:true,expectedRevision:r.workflow_revision,requestId:'company-test-001'};}
for(const type of ['ra','rb','da'])test(`company import ${type}: one approval populates only explicit identity fields, not baseline/terms/signature`,()=>{
  const r=row(type),before=C.copy(r),fields=r.workflow_state.companyImports[0].fields.map(f=>f.field);
  const result=C.decideCompanyDetails(r,cmd(r,fields),'Owner','2026-10-19');
  assert.equal(result.data.name,fixture(type).raw.party_name);assert.equal(result.data.reg,'CP-2026-002');
  assert.deepEqual(result.state.baseline,r.workflow_state.baseline);assert.deepEqual(result.state.baselineText,r.workflow_state.baselineText);
  for(const key of ['pay','inco','date','invmail','vname','vemail','clauseOverrides','_vendoraSignature'])assert.deepEqual(result.data[key],r.data[key]);
  assert.deepEqual(r,before,'no mutation of original state');
  assert.equal(result.state.decisions.at(-1).changes.length,fields.length);
  const publicData=C.publicData(result.data);assert.equal(publicData.companyImports,undefined);assert.equal(publicData.source,undefined);
});
test('company extraction refuses Vendora identity and ignores prohibited fields/prototype keys/other-family contacts',()=>{
  const f=fixture();for(const field of ['pay','invmail','vemail','__proto__','constructor','contacts.fin.p.e'])f.raw.fields.push({field,value:'invoices@vendora.se',evidence:'invoices@vendora.se',confidence:'high'});
  const extracted=D.prepare(f.raw,'ra',f.doc);assert.equal(extracted.fields.length,5);
  f.raw.party_name='Vendora Nordic AB';assert.match(D.prepare(f.raw,'ra',f.doc).issue,/extern avtalspart/);
  const g=fixture();g.raw.fields[1].value='556843-5456';g.raw.fields[1].evidence='registration number 556843-5456';assert.match(D.prepare(g.raw,'ra',g.doc).fields[1].issue,/Vendora/);
  assert.equal({}.polluted,undefined);
});
test('ambiguous parties and reversed supplier/customer roles cannot be imported',()=>{
  for(const patch of [{ambiguous:true},{role:'supplier'},{party_name:''},{party_evidence:'made-up evidence'}]){
    const f=fixture(),r=row();Object.assign(f.raw,patch);r.workflow_state.companyImports=[D.snapshot(r.data,17,D.prepare(f.raw,'ra',f.doc))];
    assert.throws(()=>C.decideCompanyDetails(r,cmd(r),'Owner','now'),e=>e.status===400);
  }
});
test('missing data and old review schema do not invent fields or block existing workflows',()=>{
  assert.equal(D.prepare(undefined,'ra',fixture().doc),null);
  const f=fixture();f.raw.fields=[];const details=D.snapshot({},1,D.prepare(f.raw,'ra',f.doc));assert.equal(details.status,'unavailable');assert.deepEqual(D.pending({companyImports:[details]}),[]);
  assert.equal(D.read({},'country'),'');assert.equal(D.read({},'sig_email'),'');
});
test('text evidence and value must match; malformed emails, duplicate fields and oversized values are rejected',()=>{
  for(const patch of [{evidence:'invented quote'},{value:'wrong value'},{value:'x'.repeat(300)}]){
    const f=fixture();Object.assign(f.raw.fields[0],patch);assert.ok(D.prepare(f.raw,'ra',f.doc).fields[0].issue);
  }
  const f=fixture();f.raw.fields.push({...f.raw.fields[0],value:'Other Customer'});assert.match(D.prepare(f.raw,'ra',f.doc).fields[0].issue,/Flera värden/);
  const g=fixture();g.raw.fields.at(-1).value='not email';g.raw.fields.at(-1).evidence='not email';g.doc.data+='\nnot email';assert.match(D.prepare(g.raw,'ra',g.doc).fields.at(-1).issue,/e-post/);
});
test('PDF suggestions remain explicitly unverified and uncertain values never become high-confidence',()=>{
  const f=fixture();f.raw.fields[0].confidence='uncertain';const details=D.prepare(f.raw,'ra',{kind:'pdf',data:'JVBERi0=',filename:'scan.pdf'});
  assert.equal(details.fields[0].confidence,'uncertain');assert.equal(details.fields[0].sourceVerified,false);
});
test('unconfirmed/empty/invalid selections cannot write, and invalid groups apply atomically',()=>{
  for(const patch of [{confirmedParty:false},{fields:[]},{fields:['name','pay']},{fields:['__proto__']},{fields:'name'},{requestId:'x'}]){
    const r=row(),before=C.copy(r);assert.throws(()=>C.decideCompanyDetails(r,{...cmd(r),...patch},'Owner','now'));assert.deepEqual(r,before);
  }
});
test('existing values require explicit selection; skipping records a decision without altering data',()=>{
  const r=row(),a=C.decideCompanyDetails(r,cmd(r,['vat']),'Owner','now');assert.equal(a.data.name,r.data.name);assert.equal(a.data.reg,r.data.reg);assert.equal(a.data.vat,'CPVAT002');
  const skip=C.decideCompanyDetails(r,{...cmd(r,[]),action:'skip',confirmedParty:false},'Owner','now');assert.deepEqual(skip.data,r.data);assert.equal(skip.state.companyImports[0].status,'skipped');
});
test('stale targets, stale revision and locked agreements refuse identity import',()=>{
  for(const status of ['invited','pending_signature','vendora_signed','sent','signed']){const r=row();r.status=status;assert.throws(()=>C.decideCompanyDetails(r,cmd(r),'Owner','now'),e=>e.status===409);}
  const r=row();r.data.reg='MANUAL';assert.throws(()=>C.decideCompanyDetails(r,cmd(r),'Owner','now'),/ändrats sedan/);
  assert.throws(()=>C.decideCompanyDetails(row(),{...cmd(row()),expectedRevision:2},'Owner','now'),e=>e.status===409);
});
test('idempotency returns the saved decision and rejects request ID reuse with different selections',()=>{
  const r=row(),body=cmd(r),a=C.decideCompanyDetails(r,body,'Owner','now');const changed={...r,data:a.data,workflow_state:a.state,workflow_revision:4};
  assert.equal(C.decideCompanyDetails(changed,body,'Owner','later').replayed,true);
  assert.throws(()=>C.decideCompanyDetails(changed,{...body,fields:['name']},'Owner','later'),/redan använt/);
});
test('pending identity import blocks signature until a decision, without treating identity as accepted terms',()=>{
  const r=row();assert.match(C.signatureProblems(r).join(' '),/företagsuppgifter/);
  const a=C.decideCompanyDetails(r,{...cmd(r,[]),action:'skip'},'Owner','now');assert.doesNotMatch(C.signatureProblems({...r,workflow_state:a.state}).join(' '),/företagsuppgifter/);
  assert.deepEqual(a.state.items,r.workflow_state.items);
});
test('real review prompt/schema uses source-only extraction in the same model call',async()=>{
  const calls=[];const raw=fixture().raw;
  class MockAnthropic{constructor(){this.beta={messages:{stream:p=>{calls.push(p);return {finalMessage:async()=>({stop_reason:'end_turn',content:[{type:'text',text:JSON.stringify({company_details:raw,findings:[],questions_for_seller:[]})}]})};}}};}}
  const file=path.resolve(__dirname,'../ai.js'),m={exports:{}};
  vm.runInNewContext(fs.readFileSync(file,'utf8'),{require:n=>n==='@anthropic-ai/sdk'?MockAnthropic:require(path.resolve(path.dirname(file),n)),module:m,exports:m.exports,process:{env:{ANTHROPIC_API_KEY:'test-only'}},console,Buffer});
  const r=await m.exports.reviewContract({type:'ra',agreement:seeds.ra,ourText:C.benchmark(seeds.ra),doc:fixture().doc});
  assert.equal(calls.length,1);assert.deepEqual(r.company_details.party_name,raw.party_name);
  const schema=calls[0].output_config.format.schema;assert.ok(schema.required.includes('company_details'));assert.deepEqual(schema.properties.company_details,D.SCHEMA);
  assert.match(calls[0].system.map(x=>x.text).join('\n'),/never our benchmark/);assert.match(calls[0].system.map(x=>x.text).join('\n'),/NEVER select Vendora/);
});

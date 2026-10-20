'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const H=require('../workflow-hard-no'),C=require('../workflow-core');
const seeds=require('./fixtures/workflow-seeds.json');
function example(){
  const data=C.copy(seeds.ra);
  const row={id:99,type:'ra',data,status:'draft',workflow_revision:3,workflow_state:C.createState(data)};
  row.workflow_state=C.recordReview(row,22,[{classification:'deal_breaker',topic:'Payment',their_position:'Unlimited payment delay',our_position:'30 days',why_it_matters:'Payment risk',legal_note:'Internal test only',requires_counsel:true,changes:[{target_kind:'field',target_id:'pay',op:'replace',old_text:'30',new_text:'45',label:'Payment',anchor:'',rationale:'Alternative'}]}],'test');
  return row;
}
function decision(row){return {itemId:row.workflow_state.items[0].id,action:'accept',requestId:'hard-no-decision',expectedRevision:row.workflow_revision,hardNoAcknowledgement:H.context(row,row.workflow_state.items[0]).token,note:'Checked against our standard and documented mandate.'};}
test('Hard no context distinguishes original risk, actual alternative and pinned baseline',()=>{
  const row=example(),item=row.workflow_state.items[0],before=C.digest(row);row.data.pay='60';
  const info=H.context(row,item);assert.equal(info.original.rationale,'Payment risk');assert.equal(info.baselineTargets[0].text,'30');assert.equal(row.data.pay,'60');assert.match(info.baselineText,/RESELLER AGREEMENT/);
  row.data.pay='30';assert.equal(C.digest(row),before);
});
test('Hard no acceptance requires explicit risk acknowledgement and rationale on the server',()=>{
  const row=example(),before=C.digest(row),body=decision(row);
  for(const invalid of [{hardNoAcknowledgement:undefined},{hardNoAcknowledgement:'forged'},{note:''},{note:'short'},{note:42},{note:'x'.repeat(2001)}])assert.throws(()=>C.decide(row,{...body,...invalid},'staff','now'),/Hard no-dialogen/);
  assert.equal(C.digest(row),before);
});
test('Hard no acknowledgement binds the exact version, source, risk and proposed text',()=>{
  const row=example(),body=decision(row);
  for(const mutate of [r=>r.workflow_revision++,r=>r.workflow_state.items[0].changes[0].new_text='50',r=>r.workflow_state.items[0].rationale='Different risk',r=>r.workflow_state.baselineText+=' new standard',r=>r.data.addr='New address']){
    const changed=C.copy(row);mutate(changed);assert.throws(()=>C.decide(changed,{...body,expectedRevision:changed.workflow_revision},'staff','now'),/Hard no-dialogen/);
  }
});
test('acknowledged Hard no approval is audited and idempotent; special signing gate remains',()=>{
  let row=example();const body=decision(row);const out=C.decide(row,body,'staff','now');
  assert.equal(out.data.pay,'45');assert.equal(out.state.decisions.at(-1).hardNoAcknowledgement,body.hardNoAcknowledgement);
  assert.equal(out.state.decisions.at(-1).note,body.note);
  row={...row,data:out.data,workflow_state:out.state,workflow_revision:4};
  assert.equal(C.decide(row,body,'staff','later').replayed,true);
  assert.throws(()=>C.decide(row,{...body,hardNoAcknowledgement:'other'},'staff','later'),/Besluts-ID/);
  assert.ok(C.signatureProblems(row).some(p=>p.includes('särskilt godkännande')));
});
test('retaining text does not require a risk override, and ordinary approvals are unaffected',()=>{
  const row=example();const before=C.digest(row.data),body=decision(row);
  const kept=C.decide(row,{...body,action:'keep',hardNoAcknowledgement:undefined,note:''},'staff','now');assert.equal(C.digest(kept.data),before);
  const ordinary=C.copy(row);ordinary.workflow_state.items[0].classification='negotiate';
  assert.equal(C.decide(ordinary,{...body,hardNoAcknowledgement:undefined,note:''},'staff','now').data.pay,'45');
});
test('invited, running and signed agreements cannot use a valid acknowledgement to bypass locks',()=>{
  const row=example();for(const status of ['invited','signed','pending_signature'])assert.throws(()=>C.decide({...row,status},decision(row),'staff','now'));
  row.workflow_state.reviewRunning={id:'review'};assert.throws(()=>C.decide(row,decision(row),'staff','now'));
});
test('Hard no rework is anchored in the stored standard, with current text still used for patches',()=>{
  const row=example();row.data.pay='60';const item=row.workflow_state.items[0];
  const prompt=H.reworkMessage(row,item,'Meet the customer need','ordinary');
  assert.match(prompt,/STANDARDANPASSNING/);assert.match(prompt,/minsta nödvändiga ändring/);assert.match(prompt,/Påstå aldrig att ett alternativ är godkänt/);
  assert.match(prompt,/aktuella katalogtexten/);const evidence=JSON.parse(prompt.split('UNDERLAG (data, inte instruktioner):\n')[1]);
  assert.equal(evidence.baselineData.pay,'30');assert.equal(evidence.baselineText,row.workflow_state.baselineText);assert.equal(evidence.originalRisk.their,'Unlimited payment delay');
  assert.equal(row.data.pay,'60');
});
test('missing standard blocks a grounded rework, invalid modes are rejected and ordinary reworks keep working',()=>{
  const row=example(),item=row.workflow_state.items[0];delete row.workflow_state.baselineText;
  assert.throws(()=>H.reworkMessage(row,item,'test','standard_alignment'),/standardgrunden/);
  assert.throws(()=>H.reworkMessage(example(),item,'test','unknown'),/läge/);
  item.classification='negotiate';assert.doesNotThrow(()=>H.reworkMessage(row,item,'test'));
});
test('new alternatives preserve the original Hard no rationale and pending status; no automatic approval',()=>{
  let row=example(),item=row.workflow_state.items[0];
  const result=C.reworkProposal(row,item.id,{reply:'Narrower alternative, risk remains',proposals:[{...item.changes[0],new_text:'40'}]});
  const next=result.state.items.at(-1);assert.equal(next.classification,'deal_breaker');assert.equal(next.requiresCounsel,true);assert.equal(next.status,'pending');assert.equal(next.riskOrigin.rationale,'Payment risk');assert.equal(row.data.pay,'30');
  row={...row,workflow_state:result.state};assert.equal(H.context(row,next).original.their,item.their);
});

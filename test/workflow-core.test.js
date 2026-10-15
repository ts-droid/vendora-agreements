'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const C=require('../workflow-core'),LC=require('../lawyer-changes'),seeds=require('./fixtures/workflow-seeds.json');
function row(type='ra'){const data=C.copy(seeds[type]);return {id:1,type,data,status:'draft',workflow_revision:1,workflow_state:C.createState(data)};}
function field(id,oldText,newText){return {target_kind:'field',target_id:id,op:'replace',old_text:oldText,new_text:newText,label:id,rationale:'test',anchor:''};}
function text(id,oldText,newText){return {target_kind:'clause',target_id:id,op:'replace',old_text:oldText,new_text:newText,label:id,rationale:'test',anchor:''};}
function findings(r){const clause=r.type==='ra'?'ra.s4.title':r.type==='rb'?'rb.s6.term':'da.s6.warranty';const old=r.type==='ra'?'full payment':r.type==='rb'?'uncured material breach':'materials and workmanship';const next=r.type==='ra'?'complete payment':r.type==='rb'?'an uncured material breach':'materials, workmanship';
 return [
 {classification:'deal_breaker',topic:'Safe alternative',changes:[field('pay',r.data.pay,'45')]},
 {classification:'negotiate',topic:'Clause clarity',changes:[text(clause,old,next)]},
 {classification:'red_flag',topic:'Keep law',changes:[]},
 {classification:'acceptable',topic:'Equivalent',changes:[]},
 {classification:'negotiate',topic:'Delivery clarification',changes:[field(r.type==='da'?'delplace':'terr',r.type==='da'?r.data.delplace:r.data.terr,'Sweden')]}];
}
for(const type of ['ra','rb','da'])test(type+': initial comparison, explicit decisions, preserved customer submission, second decisions',()=>{
 let r=row(type),original=C.digest(r.workflow_state.baseline);r.workflow_state=C.recordReview(r,9,findings(r),'now');
 assert.equal(C.pending(r.workflow_state).length,5);
 for(let i=0;i<5;i++){const body={itemId:'review:9:'+i,action:[2,3].includes(i)?'keep':'accept',expectedRevision:r.workflow_revision,requestId:'decision_'+i};const out=C.decide(r,body,'staff','now');r={...r,data:out.data,workflow_state:out.state,workflow_revision:r.workflow_revision+1};}
 assert.equal(r.data.pay,'45');assert.equal(C.pending(r.workflow_state).length,0);assert.equal(C.digest(r.workflow_state.baseline),original);
 const amendments=C.copy(r.data.clauseOverrides);const sent=C.publicData(r.data);r.workflow_state.sent={version:11,data:sent};r.status='invited';
 let out=C.receive(r,{...sent,name:'Customer AB',_vendoraSignature:{name:'Fake'},clauseOverrides:{},_proposals:{pay:{original:'FORGED',proposed:'60',comment:'Please'}}},11,'customer','now');
 assert.equal(out.data.name,'Customer AB');assert.equal(out.data.pay,'45');assert.deepEqual(out.data.clauseOverrides,amendments);assert.equal(out.data._vendoraSignature,undefined);assert.equal(out.data._proposals.pay.original,'45');
 r={...r,data:out.data,workflow_state:out.state,status:'submitted',workflow_revision:r.workflow_revision+1};
 assert.equal(C.pending(r.workflow_state).length,1);assert.ok(C.signatureProblems(r).some(x=>x.includes('förslag')));
 out=C.decide(r,{itemId:'customer:11:pay',action:'keep',expectedRevision:r.workflow_revision,requestId:'second_round'},'staff','now');
 assert.equal(out.data.pay,'45');assert.equal(C.pending(out.state).length,0);assert.deepEqual(out.data.clauseOverrides,amendments);
});
test('full title wording retains insolvency sentence on a one-word edit',()=>{const r=row();const out=C.apply(r.data,[text('ra.s4.title','full payment','complete payment')]);assert.match(out.data.clauseOverrides['ra.s4.title'],/insolvency/);assert.match(out.data.clauseOverrides['ra.s4.title'],/reclaim unpaid Products/);});
test('a failed dependent group is atomic',()=>{const r=row(),before=C.digest(r.data);assert.throws(()=>C.apply(r.data,[field('pay','30','45'),text('ra.s4.title','not present','oops')]));assert.equal(C.digest(r.data),before);});
test('stale revision, ambiguous target and missing insert anchor are blocked',()=>{const r=row();assert.throws(()=>C.checkVersion(r,0));assert.throws(()=>C.apply(r.data,[text('ra.s4.title','','replace the whole thing')]));assert.throws(()=>C.apply(r.data,[{target_kind:'clause',target_id:'4A',op:'insert',new_text:'test',anchor:'missing'}]));});
test('duplicate decisions are idempotent but a reused ID for a different decision is rejected',()=>{let r=row();r.workflow_state=C.recordReview(r,1,[findings(r)[0]],'now');const b={itemId:'review:1:0',action:'accept',expectedRevision:1,requestId:'same_request'};const result=C.decide(r,b,'a','now');r={...r,data:result.data,workflow_state:result.state,workflow_revision:2};assert.equal(C.decide(r,b,'a','later').replayed,true);assert.throws(()=>C.decide(r,{...b,action:'keep'},'a','later'));});
test('old customer versions and duplicate changed submissions cannot overwrite newer work',()=>{const r=row();r.status='invited';r.workflow_state.sent={version:2,data:C.publicData(r.data)};assert.throws(()=>C.receive(r,{name:'Old'},1,'cp','now'));const out=C.receive(r,{name:'New'},2,'cp','now');const next={...r,data:out.data,workflow_state:out.state,status:'submitted'};assert.equal(C.receive(next,{name:'New'},2,'cp','now').replayed,true);assert.throws(()=>C.receive(next,{name:'Different'},2,'cp','later'));});
test('customer internals and unsafe contact fields never replace approved data',()=>{const r=row();r.status='invited';r.workflow_state.sent={version:2,data:C.publicData(r.data)};r.data.clauseOverrides={'ra.s4.title':'approved wording'};const out=C.receive(r,{...C.publicData(r.data),clauseOverrides:{},_accepted:['pay'],_type:'da',_vendoraSignature:{name:'Fake'},rcontacts:JSON.parse('{"__proto__":{"pwn":1},"notices":{"e":"notice@example.test"}}')},2,'cp','now');assert.equal(out.data._type,'ra');assert.equal(out.data._vendoraSignature,undefined);assert.equal(out.data.clauseOverrides['ra.s4.title'],'approved wording');assert.equal({}.pwn,undefined);});
test('signed and pending-signature agreements are locked',()=>{for(const status of ['pending_signature','vendora_signed','sent','signed'])assert.throws(()=>C.editable({...row(),status}));});
test('typed catalog cannot leak across the purchasing/selling boundary',()=>{assert.throws(()=>C.apply(row('da').data,[text('ra.s4.title','full payment','x')]));assert.throws(()=>C.apply(row('rb').data,[text('ra.s4.title','full payment','x')]));});
test('standard defaults are not silently redefined by an initial commercial concession',()=>{const r=row();r.data.pay='90';const s=C.createState(r.data);assert.equal(s.baseline.pay,'30');assert.equal(r.data.pay,'90');});
test('only accepted text, not internal decisions or redlines, goes to the customer',()=>{const d={...row().data,_proposals:{x:'secret'},_accepted:['x'],redlines:[{rationale:'secret'}],clauseOverrides:{'ra.s4.title':'accepted'}};const pub=C.publicData(d);assert.equal(pub._proposals,undefined);assert.equal(pub.redlines,undefined);assert.equal(pub.clauseOverrides['ra.s4.title'],'accepted');});
test('changing a field cannot silently invalidate a previously customized dependent clause',()=>{const r=row();r.data.clauseOverrides={'ra.s4.payment':LC.resolvedClauseText(r.data,'ra.s4.payment')+' Extra protection.'};assert.throws(()=>C.apply(r.data,[field('pay','30','45')]),/följdändringen/);});
module.exports={findings};

'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const C=require('../workflow-core'),R=require('../workflow-rework'),H=require('../workflow-hard-no');
const seeds=require('./fixtures/workflow-seeds.json');
const copy=C.copy;
const change=(old='30',next='45')=>({target_kind:'field',target_id:'pay',op:'replace',old_text:old,new_text:next,label:'Payment',rationale:'Synthetic test',anchor:''});
function adapter(responses) {
  const calls=[];
  class StubAnthropic {
    constructor(){this.messages={create:async params=>{calls.push(copy(params));return copy(responses[Math.min(calls.length-1,responses.length-1)]);}};}
  }
  StubAnthropic.BadRequestError=class extends Error{};
  const mod={exports:{}};
  const sandbox={module:mod,exports:mod.exports,console,process:{env:{ANTHROPIC_API_KEY:'synthetic-test-key',AI_FALLBACKS:'0'}},Buffer,
    require:name=>name==='@anthropic-ai/sdk'?StubAnthropic:require(path.resolve(__dirname,'..',name))};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../ai.js'),'utf8'),sandbox,{filename:'ai.js'});
  return {ai:mod.exports,calls};
}
const tool=changes=>({stop_reason:'tool_use',content:[{type:'tool_use',name:'propose_changes',id:'test-call',input:{changes}}]});
const text={stop_reason:'end_turn',content:[{type:'text',text:'Pending alternative; approval required.'}]};

test('workflow rework rejects missing old_text and supplies current source feedback without guessing a replacement',()=>{
  const data=copy(seeds.ra),before=C.digest(data),bad=change('');
  const result=R.validate([bad],data);
  assert.equal(result.ok,false);assert.equal(result.proposals.length,0);assert.match(result.feedback,/Originaltext krävs/);
  assert.match(result.feedback,/ENTIRE intended group/);assert.match(result.feedback,/"currentText":"30"/);
  assert.equal(bad.old_text,'');assert.equal(C.digest(data),before);
  assert.throws(()=>C.apply(data,[bad]),/Originaltext krävs/,'final approval guard is unchanged');
});
test('whole-clause replacements require exact original text; unrelated sentences stay intact',()=>{
  const data=copy(seeds.da),target=require('../agreement-clauses').catalog('da').find(c=>c.when(data)&&c.render(data).length>100);
  const original=C.sourceText(data,{kind:'clause',id:target.id});
  const proposal={...change(''),target_kind:'clause',target_id:target.id,new_text:original+' Additional test sentence.'};
  assert.equal(R.validate([proposal],data).ok,false);
  proposal.old_text=original;const checked=R.validate([proposal],data);assert.equal(checked.ok,true);
  const preview=C.apply(data,checked.proposals);assert.equal(preview.displayed[0].oldText,original);assert.equal(preview.displayed[0].newText,proposal.new_text);
  assert.equal(C.sourceText(data,{kind:'clause',id:target.id}),original);
});
test('one invalid edit rejects the whole candidate group, not just an unvalidated tail',()=>{
  const data=copy(seeds.ra),before=C.digest(data);
  for(const proposals of [[change(),{...change(''),target_id:'curr',new_text:'USD'}],[change(),{...change(),target_id:'nonexistent'}],[{...change(),target_kind:'annex',target_id:'1A'}],[],null]){
    const result=R.validate(proposals,data);assert.equal(result.ok,false);assert.equal(result.proposals.length,0);
  }
  assert.equal(C.digest(data),before);
});
test('rework source feedback uses negotiated current text, never swaps in historical baseline text',()=>{
  const data=copy(seeds.ra);data.pay='60';
  const result=R.validate([change('')],data);assert.match(result.feedback,/"currentText":"60"/);
  assert.equal(R.validate([change('30')],data).ok,false);assert.equal(R.validate([change('60','50')],data).ok,true);
  assert.equal(data.pay,'60');
});
test('real chat adapter asks for missing original text again before returning a pending candidate',async()=>{
  const {ai,calls}=adapter([tool([change('')]),tool([change()]),text]);const data=copy(seeds.ra),before=C.digest(data);
  const out=await ai.chat(data,[{role:'user',content:'Synthetic rework'}],{agreementType:'ra',workflowRework:true});
  assert.equal(calls.length,3);assert.equal(out.proposals.length,1);assert.equal(out.proposals[0].oldText,'30');assert.equal(C.digest(data),before);
  const feedback=calls[1].messages.at(-1).content[0];assert.equal(feedback.is_error,true);assert.match(feedback.content,/"currentText":"30"/);
  assert.match(calls[0].tools[0].input_schema.properties.changes.items.properties.old_text.description,/entire CURRENT clause/);
  assert.equal(C.apply(data,out.proposals).data.pay,'45');
});
test('persistent invalid model output stays bounded and cannot return a partial proposal',async()=>{
  const {ai,calls}=adapter([tool([change(),{...change(''),target_id:'curr',new_text:'USD'}])]);
  const out=await ai.chat(copy(seeds.ra),[{role:'user',content:'Synthetic rework'}],{agreementType:'ra',workflowRework:true});
  assert.equal(calls.length,4);assert.equal(out.proposals.length,0);assert.match(out.reply,/Originaltext krävs/);
});
test('corrected complete groups replace earlier candidates rather than accumulating duplicate changes',async()=>{
  const {ai}=adapter([tool([change()]),tool([change('30','40')]),text]);
  const out=await ai.chat(copy(seeds.ra),[{role:'user',content:'Synthetic rework'}],{agreementType:'ra',workflowRework:true});
  assert.equal(out.proposals.length,1);assert.equal(out.proposals[0].newText,'40');
});
for(const stop of ['refusal','max_tokens'])test('incomplete rework '+stop+' cannot leave a previous candidate approvable',async()=>{
  const {ai}=adapter([tool([change()]),{stop_reason:stop,content:[]}]);
  const out=await ai.chat(copy(seeds.ra),[{role:'user',content:'Synthetic rework'}],{agreementType:'ra',workflowRework:true});
  assert.equal(out.proposals.length,0);
});
test('choosing original after a rework preserves negotiated text, baseline and other pending points',()=>{
  const data=copy(seeds.ra);data.pay='60';
  const row={id:42,type:'ra',status:'draft',data,workflow_revision:5,workflow_state:C.createState(data)};
  row.workflow_state=C.recordReview(row,7,[{classification:'deal_breaker',topic:'Payment',changes:[],requires_counsel:true},{topic:'Other open point',changes:[]}],'now');
  const original=C.digest(row.data),baseline=C.digest(row.workflow_state.baseline);
  const result=C.reworkProposal(row,row.workflow_state.items[0].id,{reply:'Alternative',proposals:[change('60','50')]});
  const updated={...row,workflow_state:result.state,workflow_revision:6};
  const kept=C.decide(updated,{itemId:result.itemId,action:'keep',requestId:'keep-original-test',expectedRevision:6},'tester','now');
  assert.equal(C.digest(kept.data),original);assert.equal(C.digest(kept.state.baseline),baseline);
  assert.equal(kept.state.items.at(-1).status,'kept');assert.equal(C.pending(kept.state).length,1);
  assert.equal(kept.state.decisions.at(-1).action,'keep');assert.equal(kept.state.items.at(-1).requiresCounsel,false);
});

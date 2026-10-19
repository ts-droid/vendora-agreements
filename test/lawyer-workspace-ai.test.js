'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const {createRequire}=require('node:module');
const aiPath=require.resolve('../ai');
const relativeRequire=createRequire(aiPath);
function isolated(responses) {
  const calls=[];
  class FakeAnthropic {
    constructor(){this.messages={create:async p=>{calls.push(p);if(!responses.length)throw Error('Unexpected model call');return responses.shift();}};this.beta={messages:this.messages};}
  }
  FakeAnthropic.BadRequestError=class extends Error{};
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(aiPath,'utf8'),{module,exports:module.exports,require:p=>p==='@anthropic-ai/sdk'?FakeAnthropic:relativeRequire(p),process:{env:{ANTHROPIC_API_KEY:'synthetic-test-only',AI_FALLBACKS:'0'}},console,Buffer},{filename:aiPath});
  return {ai:module.exports,calls};
}
const input={kind:'agreement',title:'Synthetic base agreement',language:'en',effective_date:'',sections:[{heading:'Scope',paragraphs:['Draft scope.']}],missing_information:['Effective date'],reference_document_ids:[],replaces_document_id:''};
const tool=i=>({stop_reason:'tool_use',content:[{type:'tool_use',id:'tool1',name:'draft_related_document',input:i}]});
const done={stop_reason:'end_turn',content:[{type:'text',text:'Separate draft prepared; not signed.'}]};
test('standalone AI workspace uses the drafting tool and keeps the full saved conversation beyond twenty messages',async()=>{
  const {ai,calls}=isolated([tool(input),done]);
  const messages=Array.from({length:25},(_,i)=>({role:i%2?'assistant':'user',content:'Saved message '+i}));
  const result=await ai.chat({_type:'general'},messages,{agreementType:'general',workspace:{source:null,documents:[],allowOriginalChanges:false}});
  assert.equal(result.documents.length,1);assert.equal(result.documents[0].title,input.title);assert.equal(result.proposals.length,0);
  assert.equal(calls[0].messages[0].content,'Saved message 0');
  assert.deepEqual(Array.from(calls[0].tools,t=>t.name),['draft_related_document']);
  assert.match(calls[0].system.map(s=>s.text).join('\n'),/Do not claim you have no memory/);
});
test('AI cannot introduce an unselected related-document reference into a saved draft',async()=>{
  const {ai,calls}=isolated([tool({...input,reference_document_ids:['someone-elses-document']}),done]);
  const result=await ai.chat({_type:'general'},[{role:'user',content:'Create a draft'}],{agreementType:'general',workspace:{source:null,documents:[],allowOriginalChanges:false}});
  assert.equal(result.documents.length,0);
  const toolResult=calls[1].messages.find(m=>Array.isArray(m.content)&&m.content[0].type==='tool_result');
  assert.equal(toolResult.content[0].is_error,true);
});
test('ordinary lawyer use remains separate from the workspace tool and keeps its existing proposal protocol',async()=>{
  const {ai,calls}=isolated([done]);
  await ai.chat({_type:'ra'},[{role:'user',content:'Explain the payment clause'}],{agreementType:'ra'});
  assert.equal(calls[0].tools.length,1);assert.equal(calls[0].tools[0].name,'propose_changes');
});

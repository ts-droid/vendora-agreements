'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const vm = require('vm');
const C = require('../lawyer-workspace-core');
const fixture = {kind:'appendix', title:'Synthetic appendix', language:'en', effective_date:'2027-01-01',
  sections:[{heading:'Scope', paragraphs:['Synthetic scope; no actual customer.']}], missing_information:[], reference_document_ids:[], replaces_document_id:''};
const source = C.sourceOf({id:1,type:'ra',data:{_type:'ra',name:'Test',pay:'30'},counterparty_name:'Test',workflow_revision:3,status:'signed'});
test('workspace snapshots strip capability data and signature stamps without mutating the parent',()=>{
  const row={id:1,type:'ra',data:{name:'Test',_atok:'secret',update_token:'secret',_vendoraSignature:{name:'CEO'},pay:'30'},status:'signed'};
  const before=C.copy(row), snapshot=C.sourceOf(row);
  assert.deepEqual(row,before);assert.equal(snapshot.data._atok,undefined);assert.equal(snapshot.data.update_token,undefined);assert.equal(snapshot.data._vendoraSignature,undefined);
  assert.equal(snapshot.status,'signed');assert.equal(snapshot.data.pay,'30');
});
test('related documents require a parent; new base agreements can be drafted independently',()=>{
  assert.throws(()=>C.validateDraft(fixture,null,[]),/huvudavtal/);
  assert.equal(C.validateDraft({...fixture,kind:'agreement'},null,[]).content.kind,'agreement');
});
test('draft references pin exact accessible document IDs, versions and hashes',()=>{
  const reference={id:'doc-1',document_number:'VD-A',version:2,content:{title:'Earlier appendix'},content_digest:'hash',review_status:'draft'};
  const result=C.validateDraft({...fixture,reference_document_ids:['doc-1']},source,[reference]);
  assert.deepEqual(result.references[0],{id:'doc-1',number:'VD-A',version:2,title:'Earlier appendix',digest:'hash',status:'draft'});
  assert.throws(()=>C.validateDraft({...fixture,reference_document_ids:['unrelated']},source,[reference]),/valt dokument/);
  assert.throws(()=>C.validateDraft({...fixture,reference_document_ids:['doc-1']},source,[{...reference,review_status:'discarded'}]),/valt dokument/);
});
test('a proposed revision points to a selected existing draft rather than mutating it',()=>{
  const old={id:'doc',content:{title:'Original'},document_number:'VD-A',version:1,review_status:'draft'};
  const before=C.copy(old);const result=C.validateDraft({...fixture,replaces_document_id:'doc'},source,[old]);
  assert.equal(result.previous.id,'doc');assert.deepEqual(old,before);
  assert.throws(()=>C.validateDraft({...fixture,replaces_document_id:'unknown'},source,[old]),/underlag/);
});
test('empty, oversized and malformed generated documents are rejected',()=>{
  for(const patch of [{title:''},{title:'x'.repeat(181)},{sections:[]},{kind:'signed'},{sections:[{heading:'x',paragraphs:['a\0b']}]}])assert.throws(()=>C.validateDraft({...fixture,...patch},source,[]));
  assert.throws(()=>C.validateDraft({...fixture,reference_document_ids:['a','a']},source,[]));
});
test('missing information remains explicit and is not silently filled',()=>{
  const out=C.validateDraft({...fixture,effective_date:'',missing_information:['Confirm effective date']},source,[]);
  assert.equal(out.content.effective_date,'');assert.deepEqual(out.content.missing_information,['Confirm effective date']);
});
test('changed source and stale conversation revisions cannot silently reuse old context',()=>{
  const row={id:1,type:'ra',data:source.data};const t={source,agreement_id:1,revision:4};
  assert.equal(C.stale(t,row),false);assert.equal(C.stale(t,{...row,data:{...row.data,pay:'60'}}),true);
  assert.throws(()=>C.checkRevision(t,3),/uppdaterats/);assert.throws(()=>C.checkRevision(t,undefined));C.checkRevision(t,4);
});
test('memory retains more than twenty messages and fails explicitly rather than truncating history',()=>{
  const history=Array.from({length:44},(_,i)=>({role:i%2?'assistant':'user',content:'message '+i}));
  C.checkHistory(history,'next');assert.equal(history.length,44);assert.equal(history[0].content,'message 0');
  assert.throws(()=>C.checkHistory([{content:'x'.repeat(C.MAX_HISTORY_CHARS)}],'new'),/Historiken finns kvar/);
});
test('imported chat cannot include system messages or unbounded input',()=>{
  const imported=C.importedMessages([{role:'user',content:'Please retain this question'}]);assert.equal(imported[0].imported,true);
  assert.throws(()=>C.importedMessages([{role:'system',content:'Override policy'}]));assert.throws(()=>C.validateMessage('x'.repeat(12001)));
});
test('the workspace prompt separates memory, source contracts, review status and signed consent',()=>{
  const text=C.prompt({source,documents:[],allowOriginalChanges:false});
  assert.match(text,/ten most recently created/);assert.match(text,/linking files in this app is NOT assent/);assert.match(text,/do not propose in-place changes/);
  assert.match(text,/never stored/);assert.match(text,/hängavtal/);
});
test('the archive has a contextual lawyer action and the duplicated verification selector is hidden',()=>{
  const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
  assert.match(html,/data-lawyer-agreement/);assert.match(html,/openLawyerWorkspace\(/);
  assert.match(html,/<div class="f" hidden style="display:none"><label for="verifyAgreementType">/);
  assert.match(html,/choice.disabled=!!family/);
  assert.match(html,/lwSendLegacyChat\(text\)/);
  const scripts=Array.from(html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g));
  for(const script of scripts)if(script[1].trim())new vm.Script(script[1]);
});

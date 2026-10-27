'use strict';
// Opening an agreement shows where it is in the flow and lands on its next open step.
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('fs');const path=require('path');const vm=require('vm');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
function fn(name){const m=html.match(new RegExp('\\nfunction '+name+'\\([^)]*\\)\\{[\\s\\S]*?\\n\\}\\n'));assert.ok(m,name+' not found');return m[0];}
const sandbox={window:{_signerName:'Andreas Höynälä'},esc:s=>String(s==null?'':s)};
vm.createContext(sandbox);
vm.runInContext(html.match(/var STAGE_STEPS = \[[^\]]+\];/)[0]+fn('fmtWhen')+fn('stageInfo')+fn('stageStripHtml'),sandbox);
test('every status maps to a stage and a next step that names the counterparty',()=>{
  const cases={draft:0,imported:0,invited:1,submitted:2,generated:2,sent:3,pending_signature:4,vendora_signed:4,signed:5};
  for(const [status,index] of Object.entries(cases)){
    const info=sandbox.stageInfo({status,counterparty_name:'Troubadour Goods Limited',counterparty_email:'ryan@example.test',signature_sent_at:'2026-10-27T13:12:00Z',counterparty_signed_by:'Ryan Batchelor',counterparty_signed_at:'2026-10-27T13:25:00Z',vendora_signed_at:'2026-10-27T13:30:00Z'});
    assert.equal(info.index,index,status);assert.equal(info.steps.length,6);assert.ok(info.next.length>20,status);
  }
  assert.match(sandbox.stageInfo({status:'sent',counterparty_email:'ryan@example.test'}).next,/Waiting for ryan@example.test to sign/);
  assert.match(sandbox.stageInfo({status:'pending_signature',counterparty_name:'Troubadour',counterparty_signed_by:'Ryan'}).next,/Ryan signed for Troubadour\. Waiting for Andreas Höynälä to countersign/);
  assert.match(sandbox.stageInfo({status:'submitted',data:{name:'From data'}}).next,/From data has submitted/);
  assert.equal(sandbox.stageInfo({}).index,0);
});
test('the strip marks done, current and upcoming steps',()=>{
  const strip=sandbox.stageStripHtml({status:'sent',counterparty_name:'X'});
  assert.equal((strip.match(/class='done'/g)||[]).length,3);assert.equal((strip.match(/class='now'/g)||[]).length,1);
  assert.match(strip,/class='now'>4 · Counterparty signs/);assert.match(strip,/class='stage-next'>Waiting for X to sign/);
});
test('the strip is shown in the archive panel, the signing view and the review page',()=>{
  assert.match(html,/id="apStage"/);
  assert.match(html,/stage\.innerHTML=stageStripHtml\(a\)/);
  assert.match(html,/sigHeader\(kicker, a, meta\.join\(" &nbsp;·&nbsp; "\)\)\+"<div style='margin-top:14px'>"\+stageStripHtml\(a\)/);
  assert.match(html,/stageStripHtml\(\{status:"submitted", counterparty_name:d\.name\}\)/);
});
test('opening from the archive lands on the next open step and clears a stale workflow panel',()=>{
  const open=fn('archiveEdit');
  assert.match(open,/a\.status==="submitted" && !a\.workflow_state/);
  assert.match(open,/"#review="\+\(encodeData\(d\)\|\|""\)/);
  assert.match(open,/\["sent","pending_signature","signed","vendora_signed"\]\.indexOf\(a\.status\)>=0\) renderSigningView\(a\)/);
  assert.match(open,/if\(window\.wfReset && \(!a\.workflow_state \|\| \(window\._editing && window\._editing\.id!==a\.id\)\)\) wfReset\(\)/);
  const ui=fs.readFileSync(path.join(__dirname,'..','workflow-ui.js'),'utf8');
  assert.match(ui,/function reset\(\)\{[^\n]*document\.querySelectorAll\('\[id\^="wf_panel_"\]'\)\.forEach\(function\(panel\)\{panel\.remove\(\);\}\)/);
  assert.match(html,/window\.location\.hash==="#archive"\)\{ switchTab\(3\)/);
});

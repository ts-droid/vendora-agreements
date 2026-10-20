#!/usr/bin/env node
'use strict';
// This is an opt-in, paid, real-provider evaluation, not an application test mock.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const cases=require('./cases.cjs'),{grade,aggregate}=require('./score.cjs');
const outDir=path.resolve(process.env.AI_EVAL_OUTPUT||'ai-eval-results');
const repeats=Number(process.env.AI_EVAL_REPEATS||1);
const suite=process.env.AI_EVAL_SUITE||'smoke';
if(!Number.isInteger(repeats)||repeats<1||repeats>3||!['smoke','all'].includes(suite))throw Error('Use smoke/all and 1..3 repeats.');
const selected=suite==='all'?cases:[cases[0],cases[1],cases[4]];
fs.mkdirSync(outDir,{recursive:true});
const sha=v=>crypto.createHash('sha256').update(v).digest('hex');
const root=path.resolve(__dirname,'../..');
const git=spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'});
const report={schema:1,kind:'live-provider-company-extraction',startedAt:new Date().toISOString(),status:'not_started',
  testedCommit:git.status===0?git.stdout.trim():null,suite,repeats,plannedCalls:selected.length*repeats,
  reviewInvocations:0,requestedModel:null,resolvedModel:null,providerRequestCount:null,
  fixtureSha256:sha(fs.readFileSync(path.join(__dirname,'cases.cjs'))),
  sourceHashes:Object.fromEntries(['ai.js','counterparty-details.js','lawyer-changes.js','agreement-clauses.js'].map(p=>[p,sha(fs.readFileSync(path.join(root,p)))])),
  limitations:['Synthetic text documents only; not measured on real customer agreements, scanned PDFs or layout parsing.',
    'Requested model recorded. The current production adapter does not expose the resolved model/usage to its caller.',
    'No registry, signatory-authority, legal-review quality or real signature verification.',
    'No production database or outbound email. A small fixed corpus is not a population accuracy estimate.'],
  results:[],metrics:null};
function save(){fs.writeFileSync(path.join(outDir,'results.json'),JSON.stringify(report,null,2));}
async function main(){
  if(!process.env.ANTHROPIC_API_KEY){report.status='blocked_missing_credential';save();console.log('BLOCKED: ANTHROPIC_API_KEY unavailable. Zero live calls; no accuracy score.');return 2;}
  if(process.env.AI_EVAL_ALLOW_LIVE!=='1'){report.status='blocked_live_opt_in_required';save();console.log('BLOCKED: explicitly set AI_EVAL_ALLOW_LIVE=1 to authorise paid calls.');return 2;}
  // Disable automatic model substitution for a controlled benchmark. Prompts/schema unchanged.
  process.env.AI_FALLBACKS='0';
  const ai=require('../../ai'),core=require('../../workflow-core');
  const seeds=require('../../test/fixtures/workflow-seeds.json');
  report.requestedModel=ai.MODEL;report.status='running';save();
  for(let repeat=1;repeat<=repeats;repeat++)for(const item of selected){
    const result={id:item.id,repeat,sourceSha256:sha(item.source),expected:item.expected};
    const started=Date.now();report.reviewInvocations++;
    try{
      const agreement=JSON.parse(JSON.stringify(seeds[item.type]));
      // Deliberately unrelated prefilled details ensure extraction does not borrow its answers.
      Object.assign(agreement,{name:'Benchmark Decoy Test Company',reg:'DECOY-000',vat:'DECOYVAT-000',country:'Benchmark Country',addr:'Decoy Address'});
      const review=await ai.reviewContract({type:item.type,agreement,ourText:core.benchmark(agreement),doc:{kind:'text',data:item.source,filename:item.id+'.txt'},playbook:{}});
      result.raw=review.company_details||null;result.grade=grade(item,result.raw);
      result.elapsedMs=Date.now()-started;report.results.push(result);save();
      console.log(item.id+' repeat '+repeat+': '+(result.grade.passed?'PASS':'FAIL'));
    }catch(e){
      // Error messages/objects may contain HTTP data. Do not publish them or headers.
      result.error={status:Number.isInteger(e?.status)?e.status:null,kind:'provider_or_adapter_error'};
      result.elapsedMs=Date.now()-started;report.results.push(result);report.status='incomplete_provider_error';
      report.metrics=aggregate(report.results);save();console.log('STOP: provider/adapter error; details deliberately not logged.');return 1;
    }
  }
  report.metrics=aggregate(report.results);report.status=report.metrics.pass?'completed_pass':'completed_fail';
  report.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({status:report.status,metrics:report.metrics}));
  return report.metrics.pass?0:1;
}
main().then(code=>{process.exitCode=code;}).catch(()=>{report.status='incomplete_harness_error';save();console.error('Harness error; no successful accuracy claim.');process.exitCode=1;});

'use strict';
const Details=require('../../counterparty-details');
const norm=v=>String(v??'').normalize('NFKC').replace(/\s+/gu,' ').trim();
const equal=(field,a,b)=>field.endsWith('.e')||field==='sig_email'?norm(a).toLowerCase()===norm(b).toLowerCase():norm(a)===norm(b);
// Nonempty out-of-schema values are NOT silently discarded by the grader.
function scoreFields(expected, fields, correctParty) {
  const seen=new Set(),correct=new Set(),errors=[];let tp=0,fp=0;
  for(const f of fields){
    if(!f||typeof f.field!=='string'||typeof f.value!=='string'||!f.value.trim()){fp++;errors.push('invalid_field');continue;}
    if(seen.has(f.field)){fp++;errors.push('duplicate:'+f.field);continue;}
    seen.add(f.field);
    if(correctParty&&Object.hasOwn(expected,f.field)&&equal(f.field,f.value,expected[f.field])){tp++;correct.add(f.field);}
    else{fp++;errors.push('incorrect_or_unsupported:'+f.field);}
  }
  const missing=Object.keys(expected).filter(k=>!correct.has(k));
  return {tp,fp,fn:missing.length,missing,errors};
}
function grade(item, raw) {
  const expected=item.expected,valid=!!raw&&typeof raw==='object'&&!Array.isArray(raw);
  const fields=valid&&Array.isArray(raw.fields)?raw.fields:[];
  const ambiguous=valid&&raw.ambiguous===true;
  const partyCorrect=expected.ambiguous
    ? valid&&ambiguous&&fields.length===0
    : valid&&raw.ambiguous===false&&equal('name',raw.party_name,expected.party)&&raw.role===expected.role;
  const rawScore=scoreFields(expected.fields,fields,partyCorrect);
  const critical=[];
  if(!valid||!Array.isArray(raw.fields))critical.push('invalid_company_details');
  if(!partyCorrect)critical.push(expected.ambiguous?'failed_abstention':'wrong_or_unresolved_party');
  let supportedQuotes=0;
  for(const f of fields){
    const ok=f&&typeof f.evidence==='string'&&!!norm(f.evidence)&&norm(item.source).includes(norm(f.evidence))&&norm(f.evidence).includes(norm(f.value));
    if(ok)supportedQuotes++;
    else critical.push('unsupported_quote:'+String(f?.field));
  }
  if(!expected.ambiguous&&valid&&(!norm(raw.party_evidence)||!norm(item.source).includes(norm(raw.party_evidence))||!norm(raw.party_evidence).includes(norm(expected.party))))critical.push('unsupported_party_quote');
  if(rawScore.fp)critical.push('wrong_or_unsupported_field_value');
  const prepared=valid?Details.prepare(raw,item.type,{kind:'text',data:item.source,filename:item.id+'.txt'}):null;
  const importable=prepared&&!prepared.issue?prepared.fields.filter(f=>!f.issue):[];
  const guardScore=scoreFields(expected.fields,importable,partyCorrect);
  const guardUnsafe=!expected.ambiguous&&!partyCorrect&&importable.length>0||expected.ambiguous&&importable.length>0||guardScore.fp>0;
  return {
    id:item.id,type:item.type,partyCorrect,
    raw:{...rawScore,supportedQuotes,quoteCount:fields.length},
    afterGuard:{...guardScore,importableCount:importable.length,unsafeCandidate:guardUnsafe},
    critical:[...new Set(critical)],
    passed:partyCorrect&&rawScore.fp===0&&rawScore.fn===0&&critical.length===0
  };
}
function aggregate(results) {
  const sum=(name,key)=>results.reduce((s,r)=>s+(r.grade?.[name]?.[key]||0),0);
  const metrics=name=>{const tp=sum(name,'tp'),fp=sum(name,'fp'),fn=sum(name,'fn');return {tp,fp,fn,precision:tp+fp?tp/(tp+fp):null,recall:tp+fn?tp/(tp+fn):null};};
  const evaluated=results.filter(r=>r.grade);
  return {
    attempted:results.length,evaluated:evaluated.length,errors:results.length-evaluated.length,
    exactCasesPassed:evaluated.filter(r=>r.grade.passed).length,
    partiesCorrect:evaluated.filter(r=>r.grade.partyCorrect).length,
    criticalCases:evaluated.filter(r=>r.grade.critical.length).length,
    unsafeImportCandidates:evaluated.filter(r=>r.grade.afterGuard.unsafeCandidate).length,
    raw:metrics('raw'),afterGuard:metrics('afterGuard'),
    // Never equate valid JSON or blocked errors to a successful evaluation.
    pass:results.length>0&&evaluated.length===results.length&&evaluated.every(r=>r.grade.passed)
  };
}
module.exports={grade,aggregate,norm};

'use strict';
// Vendora-first state transitions. No IO and no AI calls: every write is explicit and testable.
const crypto = require('crypto');
const LC = require('./lawyer-changes');
const clauses = require('./agreement-clauses');
const counterpartyDetails = require('./counterparty-details');
const fs = require('fs');
const TEMPLATE_VERSION = crypto.createHash('sha256').update(fs.readFileSync(require.resolve('./agreement-clauses'))).update(fs.readFileSync(require.resolve('./agreement-defaults.json'))).digest('hex');
const DEFAULTS=require('./agreement-defaults.json');
const TYPES = ['ra', 'rb', 'da'];
const EDIT_KEYS = ['clauseOverrides','clauseInserts','clauseDeletes','annexOverrides','annexDeletes','redlines'];
const FACTS = ['name','reg','country','addr','vat','eori','parent','sig_name','sig_title','sig_email','sig_phone'];
const TERMS = Object.keys(LC.FIELDS).filter(k => !FACTS.includes(k)).concat(['targets']);
const copy = x => JSON.parse(JSON.stringify(x));
function stable(x) {
  if (Array.isArray(x)) return '['+x.map(stable).join(',')+']';
  if (x && typeof x === 'object') return '{'+Object.keys(x).sort().filter(k=>x[k]!==undefined).map(k=>JSON.stringify(k)+':'+stable(x[k])).join(',')+'}';
  return JSON.stringify(x);
}
const digest = x => crypto.createHash('sha256').update(stable(x)).digest('hex');
function error(message, status=409) { const e=new Error(message);e.status=status;return e; }
function checkVersion(row, version) { if (!Number.isInteger(version)||version!==Number(row.workflow_revision||0)) throw error('Avtalet har ändrats. Ladda om och granska den senaste versionen.'); }
function editable(row) { if (['pending_signature','vendora_signed','signed','sent'].includes(row.status)||row.vendora_signed_at) throw error('Avtalet är låst för godkännande eller underskrift. Återkalla först.'); }
function ensureType(data) { if(!data||!TYPES.includes(data._type))throw error('Välj rätt avtalstyp.',400); }
function stripTransient(data) { const out=copy(data||{});['_atok','_aid','_review','_trackChanges','_isPreview','_revision','_sentVersion'].forEach(k=>delete out[k]); return out; }
function standard(data) { const d=stripTransient(data);EDIT_KEYS.concat(['_proposals','_accepted','_vendoraSignature']).forEach(k=>delete d[k]);return d; }
function benchmark(data) {
  const label=data._type==='da'?'DISTRIBUTOR AGREEMENT':'RESELLER AGREEMENT'+(data._type==='rb'?' — SIMPLIFIED':'');
  return label+'\nVendora standard template\n'+clauses.catalog(data._type).filter(c=>c.when(data)).map(c=>c.label+'\n'+c.render(data)).join('\n\n');
}
function createState(data) {
  ensureType(data); return {schema:1, templateVersion:TEMPLATE_VERSION, baseline:{...standard(data),...DEFAULTS[data._type]}, baselineText:benchmark({...standard(data),...DEFAULTS[data._type]}), round:0, items:[], decisions:[], sent:null, reviewRunning:null};
}
function state(row) { if(!row.workflow_state||row.workflow_state.schema!==1) throw error('Starta avtalsflödet först.',400); return row.workflow_state; }
function pending(s) { return (s.items||[]).filter(i=>i.status==='pending'); }
function sourceText(data,target) {
  return target.kind==='field'?String(data[target.id]??''):LC.resolvedClauseText(data,target.id);
}
function validFields(data) {
  const r=LC.validateStoredAgreement(data); if(!r.ok)throw error('Ogiltiga avtalsuppgifter: '+r.errors.join('; '),400);
  for(const k of ['lead']) if(data[k]!==undefined&&data[k]!==''&&(!/^\d+$/.test(String(data[k]))||Number(data[k])<1||Number(data[k])>365))throw error('Ogiltigt värde för '+k,400);
  for(const k of ['mdfb','mdft','mdfc']) if(data[k]!==undefined&&data[k]!==''&&(!/^\d+(\.\d+)?$/.test(String(data[k]))||Number(data[k])>100))throw error('Ogiltig procentsats: '+k,400);
}
function apply(data, changes) {
  if(!Array.isArray(changes)||!changes.length)throw error('Förslaget saknar en tillämpbar ändring. Behåll lydelsen eller bearbeta förslaget.',400);
  let next=copy(data); const displayed=[];
  for(const raw of changes){
    const p=LC.fromToolChange(raw);
    if(!p||!p.target||!['clause','field'].includes(p.target.kind))throw error('Använd en exakt klausul eller ett avtalsfält, inte en hel bilaga.',400);
    const template=clauses.catalog(data._type).find(c=>c.id===p.target.id);
    if(template&&!template.when(next))throw error('Klausulen ingår inte i den valda avtalsvarianten.',400);
    if(p.target.kind==='clause'&&p.op!=='insert'&&!clauses.catalog(data._type).some(c=>c.id===p.target.id)&&!(next.clauseInserts||[]).some(c=>c.id===p.target.id))throw error('Klausulen finns inte i detta Vendora-avtal.',400);
    if(p.op==='insert' && (!p.anchor || (!clauses.catalog(data._type).some(c=>c.id===p.anchor)&&(next.clauseInserts||[]).every(c=>c.id!==p.anchor))))throw error('En ny klausul måste ha en exakt, befintlig placering.',400);
    if(p.op!=='insert' && !String(p.oldText||'').trim() && sourceText(next,p.target).trim())throw error('Originaltext krävs för att ersätta befintlig text.',400);
    const view=LC.describeProposal(next,p);if(!view.ok)throw error('Texten matchar inte längre: '+view.errors.join('; '));
    const r=LC.applyProposals(next,[p]); if(r.rejected.length)throw error(r.rejected.map(x=>x.errors.join('; ')).join('; '));
    displayed.push({target:p.target,oldText:view.oldText,newText:view.newText,label:p.label});next=r.data;
  }
  // Never silently break an earlier negotiated paragraph when changing a bound form field.
  for(const c of clauses.catalog(data._type)){
    if(c.render(data)!==c.render(next) && (data.clauseOverrides||{})[c.id] && !changes.some(p=>LC.fromToolChange(p).target.id===c.id))throw error('Fältet påverkar redan anpassad klausul '+c.label+'. Föreslå och godkänn följdändringen i samma grupp.');
  }
  validFields(next);
  const old=new Set(LC.consistencyCheck(data).map(i=>i.message));
  const introduced=LC.consistencyCheck(next).filter(i=>!old.has(i.message));
  if(introduced.length)throw error('Motstridiga villkor: '+introduced.map(i=>i.message).join('; '));
  return {data:next,displayed};
}
function preconditions(data, changes) {
  return (changes||[]).map(raw=>{const p=LC.fromToolChange(raw);return p&&p.target?{target:p.target,hash:digest(sourceText(data,p.target))}:null;}).filter(Boolean);
}
function checkTargets(data, item) {
  for(const expected of item.preconditions||[])if(digest(sourceText(data,expected.target))!==expected.hash)throw error('Måltexten har ändrats sedan förslaget skapades. Bearbeta förslaget mot den senaste versionen.');
}
function reviewItems(row, reviewId, findings) {
  const s=state(row); const items=(findings||[]).map((f,index)=>{
    const changes=Array.isArray(f.changes)?f.changes:[];
    let issue='',preview=[];
    if(changes.length){try{preview=apply(row.data,changes).displayed;}catch(e){issue=e.message;}}
    return {id:'review:'+reviewId+':'+index,source:'comparison',sourceRef:f.their_clause_ref||'',preconditions:preconditions(row.data,changes),documentRevision:Number(row.workflow_revision),reviewId,round:s.round+1,status:'pending',classification:f.classification,topic:f.topic||'Avvikelse',their:f.their_position||'',our:f.our_position||'',rationale:f.why_it_matters||'',proposed:f.proposed_wording||'',legal:f.legal_note||'',changes,preview,issue,requiresCounsel:!!f.requires_counsel,requiresCounselOnAccept:!!f.requires_counsel};
  });return items;
}
// A rework is still only a proposal. Do not retire the old item or modify the
// agreement unless the complete new change group can be previewed safely.
function reworkProposal(row, itemId, out) {
  editable(row);
  const s=copy(state(row));
  if(s.reviewRunning||row.status==='invited')throw error('Invänta jämförelsen eller kundens svar.');
  const target=s.items.find(i=>i.id===itemId&&i.status==='pending');
  if(!target)throw error('Förslaget är inte längre öppet.');
  const proposals=out&&out.proposals;
  if(!Array.isArray(proposals)||!proposals.length){
    const e=error('Advokaten föreslog ingen tillämpbar textändring. Vår lydelse är oförändrad. Behåll den eller precisera önskemålet.',422);
    e.explanation=String(out&&out.reply||'').slice(0,12000);throw e;
  }
  const result=apply(row.data,proposals);
  if(!result.displayed.some(p=>p.oldText!==p.newText))throw error('Förslaget är identiskt med vår befintliga lydelse. Välj att behålla texten.',422);
  const next={...target,id:'alternative:'+crypto.randomUUID(),status:'pending',source:'alternative',
    preconditions:preconditions(row.data,proposals),documentRevision:Number(row.workflow_revision),
    changes:copy(proposals),preview:result.displayed,issue:'',rationale:String(out.reply||''),
    proposed:result.displayed.map(p=>p.newText).join('\n\n')};
  // A fresh alternative must not inherit a previous decision identity.
  delete next.decidedBy;delete next.decidedAt;
  target.status='superseded';s.items.push(next);
  return {state:s,itemId:next.id};
}
function recordReview(row, reviewId, findings, at) {
  const s=copy(state(row)); if(pending(s).length)throw error('Behandla befintliga förslag innan en ny jämförelse startas.');
  s.round++;s.items.push(...reviewItems(row,reviewId,findings));s.reviewRunning=null;s.lastReview={id:reviewId,at};return s;
}
function decide(row, body, actor, at) {
  editable(row);const s=copy(state(row));
  if(!/^[A-Za-z0-9_-]{8,100}$/.test(body.requestId||''))throw error('Besluts-ID krävs.',400);
  const repeat=s.decisions.find(d=>d.requestId===body.requestId);
  const command=digest({itemId:body.itemId,action:body.action,note:body.note||''});
  if(repeat){if(repeat.command!==command)throw error('Besluts-ID har redan använts för ett annat beslut.');return {data:row.data,state:s,replayed:true};}
  checkVersion(row,body.expectedRevision);
  const item=s.items.find(i=>i.id===body.itemId);if(!item||item.status!=='pending')throw error('Förslaget är redan behandlat eller tillhör inte avtalet.');
  if(!['accept','keep'].includes(body.action))throw error('Välj godkänn eller behåll vår lydelse.',400);
  let data=copy(row.data);
  if(body.action==='accept'){checkTargets(data,item);data=apply(data,item.changes).data;}
  item.status=body.action==='accept'?'accepted':'kept';
  item.decidedBy=actor;item.decidedAt=at;
  if(body.action==='keep')item.requiresCounsel=false; // Retaining our text is not accepting their risky clause.
  s.decisions.push({requestId:body.requestId,command,itemId:item.id,action:body.action,actor,at,note:String(body.note||'').slice(0,2000),revision:Number(row.workflow_revision)+1});
  if(item.field){delete (data._proposals||{})[item.field]; if(body.action==='accept')data._accepted=Array.from(new Set((data._accepted||[]).concat(item.field)));}
  return {data,state:s};
}
// Separate data-completion decision: never accepts the uploaded contract's terms.
function decideCompanyDetails(row,body,actor,at) {
  editable(row);const s=copy(state(row));
  if(!/^[A-Za-z0-9_-]{8,100}$/.test(body.requestId||''))throw error('Besluts-ID krävs.',400);
  if(!Array.isArray(body.fields)||body.fields.length>40||body.fields.some(k=>typeof k!=='string'))throw error('Välj giltiga fält.',400);
  const selected=Array.from(new Set(body.fields)).sort();
  const command=digest({importId:body.importId,action:body.action,fields:selected,confirmedParty:body.confirmedParty===true});
  const previous=s.decisions.find(d=>d.requestId===body.requestId);
  if(previous){if(previous.command!==command)throw error('Besluts-ID är redan använt.');return {data:row.data,state:s,replayed:true};}
  checkVersion(row,body.expectedRevision);
  if(s.reviewRunning||row.status==='invited')throw error('Invänta jämförelsen eller kundens svar.');
  const group=(s.companyImports||[]).find(i=>i.id===body.importId);
  if(!group||group.status!=='pending')throw error('Importförslaget är redan behandlat eller tillhör inte avtalet.');
  if(!['apply','skip'].includes(body.action))throw error('Välj import eller behåll befintliga uppgifter.',400);
  const data=copy(row.data),changes=[];
  if(body.action==='apply'){
    if(group.issue||body.confirmedParty!==true)throw error(group.issue||'Bekräfta att rätt juridisk avtalspart har identifierats.',400);
    if(!selected.length)throw error('Markera minst en uppgift att föra in.',400);
    for(const field of selected){
      const f=group.fields.find(x=>x.field===field);
      if(!f||f.issue||!counterpartyDetails.available(row.type).includes(field))throw error('Fältet kan inte importeras: '+field,400);
      if(counterpartyDetails.read(data,field)!==f.previous)throw error('Uppgiften har ändrats sedan jämförelsen: '+f.label+'. Behåll befintliga uppgifter och gör en ny jämförelse.');
      counterpartyDetails.write(data,field,f.value);changes.push({field,oldValue:f.previous,newValue:f.value});
    }
    for(const c of clauses.catalog(row.type))if((row.data.clauseOverrides||{})[c.id]&&c.render(row.data)!==c.render(data))throw error('Uppgifterna påverkar en redan anpassad klausul: '+c.label+'. Anpassa och granska klausulen separat.');
    validFields(data);
    const old=new Set(LC.consistencyCheck(row.data).map(x=>x.message));
    const conflicts=LC.consistencyCheck(data).filter(x=>!old.has(x.message));
    if(conflicts.length)throw error('Motstridiga uppgifter: '+conflicts.map(x=>x.message).join('; '));
    s.counselApproval=null;
  } else if(selected.length)throw error('Inga fält får väljas när importen avstås.',400);
  group.status=body.action==='apply'?'applied':'skipped';group.decidedBy=actor;group.decidedAt=at;
  group.fields.forEach(f=>{f.status=body.action==='apply'&&selected.includes(f.field)?'imported':'kept';});
  s.decisions.push({requestId:body.requestId,command,importId:group.id,action:'company-'+body.action,actor,at,changes,revision:Number(row.workflow_revision)+1});
  return {data,state:s};
}
function publicData(data) {
  const d=stripTransient(data);Object.keys(d).forEach(k=>{if(k[0]==='_'||['redlines','workflow_state','workflow_revision'].includes(k))delete d[k];});d._type=data._type;
  // Only accepted text modifications are included; never audit records, model rationale or internal alternatives.
  if(d.clauseInserts)d.clauseInserts=d.clauseInserts.map(i=>({id:i.id,anchor:i.anchor,label:i.label,text:i.text}));
  return d;
}
function value(v,max=2000) {if(typeof v!=='string')throw error('Uppgiften måste vara text.',400);if(v.length>max)throw error('Uppgiften är för lång.',400);return v.trim();}
function contacts(v,distribution) {
  if(!v||typeof v!=='object'||Array.isArray(v))throw error('Ogiltiga kontaktuppgifter.',400);
  const out={};for(const [role,c] of Object.entries(v)){
    if(!/^[a-z][a-z0-9_]{0,39}$/.test(role)||['constructor','prototype'].includes(role))continue;
    if(!c||typeof c!=='object')throw error('Ogiltig kontakt.',400);
    const person=p=>{const o={};for(const k of ['n','e','p','t'])if(p&&p[k]!=null)o[k]=value(p[k],300);return o;};
    out[role]=distribution?{label:String(c.label||role).slice(0,100),p:person(c.p),b:person(c.b)}:person(c);
  }return out;
}
function receive(row, submitted, sentVersion, actor, at) {
  const s=copy(state(row));editable(row);
  if(!s.sent||s.sent.version!==Number(sentVersion)||!['invited','submitted'].includes(row.status))throw error('Länken gäller en äldre eller stängd avtalsversion. Kontakta Vendora.');
  const fingerprint=digest({submitted,sentVersion});
  if(s.lastSubmission===fingerprint)return {data:row.data,state:s,replayed:true};
  if(row.status==='submitted')throw error('Uppgifterna är redan inlämnade och behandlas av Vendora.');
  const d=copy(row.data);
  for(const k of FACTS)if(Object.hasOwn(submitted,k))d[k]=value(submitted[k]);
  if(submitted.contacts)d.contacts=contacts(submitted.contacts,true);
  if(submitted.rcontacts)d.rcontacts=contacts(submitted.rcontacts,false);
  for(const k of ['pos_physical','pos_web'])if(Object.hasOwn(submitted,k)){
    if(!Array.isArray(submitted[k])||submitted[k].length>100)throw error('Ogiltig lista över försäljningsställen.',400);d[k]=submitted[k].map(x=>value(x,500));
  }
  const source=submitted._proposals||{}; const requests={};
  for(const k of TERMS){
    const raw=source[k];const actual=s.sent.data[k];
    const changed=Object.hasOwn(submitted,k)&&stable(submitted[k])!==stable(actual);
    if(raw||changed){const proposed=value(raw?raw.proposed:String(submitted[k]??''));if(proposed===String(actual??''))continue;requests[k]={original:String(actual??''),proposed,comment:raw?value(raw.comment||'',2000):''};}
  }
  s.round++;
  for(const [field,p] of Object.entries(requests)){
    const change={target_kind:'field',target_id:field,op:'replace',old_text:String(d[field]??''),new_text:p.proposed,label:field,rationale:p.comment,anchor:''};
    let issue='',preview=[];try{preview=apply(d,[change]).displayed;}catch(e){issue=e.message;}
    s.items.push({id:'customer:'+s.sent.version+':'+field,source:'customer',documentRevision:Number(row.workflow_revision)+1,preconditions:preconditions(d,[change]),round:s.round,status:'pending',classification:'negotiate',field,topic:field,their:p.proposed,our:p.original,rationale:p.comment,changes:[change],preview,issue});
  }
  d._proposals=requests;s.lastSubmission=fingerprint;s.submittedAt=at;validFields(d);
  return {data:d,state:s};
}
function signatureProblems(row) {
  const s=state(row),problems=[];
  if(s.reviewRunning)problems.push('En jämförelse pågår.');
  if(counterpartyDetails.pending(s).length)problems.push('Granska eller avstå från import av företagsuppgifter först.');
  if(pending(s).length)problems.push(pending(s).length+' ändringsförslag väntar på beslut.');
  if(s.items.some(i=>i.status==='accepted'&&i.requiresCounsel)&&(!s.counselApproval||s.counselApproval.digest!==digest(row.data)))problems.push('Dokumenterat särskilt godkännande krävs för accepterade riskvillkor.');
  for(const k of ['name','reg','country','addr','sig_name','sig_email'])if(!String(row.data[k]||'').trim()||/^\[.*\]$/.test(String(row.data[k])))problems.push('Saknad uppgift: '+k);
  if(row.type==='ra'&&!(row.data.pos_physical||[]).length&&!(row.data.pos_web||[]).length)problems.push('Minst ett försäljningsställe krävs.');
  if(s.templateVersion!==TEMPLATE_VERSION)problems.push('Standarden har uppdaterats. Detta ärende kräver en uttrycklig versionsgranskning.');
  problems.push(...LC.consistencyCheck(row.data).map(i=>i.message));return problems;
}
function summary(row) {
  const s=state(row),deviations=LC.deviationLines(row.data);
  for(const key of TERMS)if(stable(row.data[key])!==stable(s.baseline[key]))deviations.push(key+': '+String(s.baseline[key]??'—')+' → '+String(row.data[key]??'—'));
  return {terms:[['Motpart',row.data.name||''],['Avtalstyp',row.type],['Version',String(row.workflow_revision)],['Betalning',String(row.data.pay||'')+' dagar']],deviations:Array.from(new Set(deviations))};
}
module.exports={reworkProposal,decideCompanyDetails,TEMPLATE_VERSION,FACTS,TERMS,EDIT_KEYS,copy,digest,error,editable,checkVersion,stripTransient,standard,benchmark,createState,state,pending,sourceText,apply,preconditions,checkTargets,reviewItems,recordReview,decide,publicData,receive,signatureProblems,summary,validFields};

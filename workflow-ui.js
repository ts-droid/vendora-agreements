// Visible feedback starts before the first await and survives workspace re-renders.
// Elapsed time is not a percentage or a claim about model-internal progress.
window.WorkflowActivity = (function () {
  'use strict';
  var active = new Map();
  var originals = new Map();
  var selectors = '[data-wf], [id^="cr_btn_"], [id^="cr_file_"], #editBar button, .genbar button, .tabs button, .tab-panel input, .tab-panel select, .tab-panel textarea';
  function sync() {
    document.querySelectorAll(selectors).forEach(function (button) {
      if (!active.size) return;
      if (!originals.has(button)) originals.set(button, button.disabled);
      button.disabled = true;
    });
  }
  function restore() {
    if (active.size) return sync();
    originals.forEach(function (disabled, button) { if (button.isConnected) button.disabled = disabled; });
    originals.clear();
  }
  function start(key, host, label) {
    if (active.has(key)) return null;
    var started = Date.now(), message = label;
    var node = document.createElement('div'); node.className = 'wf-activity';
    node.innerHTML = '<span class="wf-spinner" aria-hidden="true"></span><div><strong role="status" aria-live="polite"></strong><div class="wf-elapsed" aria-hidden="true"></div><div class="wf-wait-note"></div></div>';
    var lastLabel = '';
    function paint() {
      var target = host();
      if (target && !target.contains(node)) { target.replaceChildren(node); target.setAttribute('aria-busy', 'true'); }
      if (message !== lastLabel) { node.querySelector('strong').textContent = message; lastLabel = message; }
      var secs = Math.floor((Date.now() - started) / 1000);
      node.querySelector('.wf-elapsed').textContent = 'Tid sedan start: ' + Math.floor(secs / 60) + ':' + String(secs % 60).padStart(2, '0');
      node.querySelector('.wf-wait-note').textContent = secs >= 90
        ? 'Det kan ta flera minuter. Starta inte en ny granskning medan denna pågår.'
        : 'Vänta på resultatet. Inga avtalsändringar godkänns automatiskt.';
      sync();
    }
    active.set(key, true); paint();
    var timer = setInterval(paint, 1000), finished = false;
    return {
      stage: function (text) { if (!finished) { message = text; paint(); } },
      finish: function (text, bad) {
        if (finished) return; finished = true; clearInterval(timer); active.delete(key);
        var target = host();
        if (target) { target.setAttribute('aria-busy', 'false'); target.replaceChildren();
          target.classList.remove('wf-warning','wf-note');target.classList.add('wf-feedback',bad?'wf-warning':'wf-note');
          target.setAttribute('role', bad ? 'alert' : 'status'); target.textContent = text || ''; }
        restore();
      }
    };
  }
  var style = document.createElement('style');
  style.textContent = 'body.wf-case-open .genbar{position:static} .wf-activity{display:flex;align-items:flex-start;gap:12px;padding:14px;margin:12px 0;background:#eef5f1;border:1px solid #b8cfc2;border-radius:10px;color:var(--navy);font-size:14px;line-height:1.5}.wf-spinner{display:inline-block;flex-shrink:0;width:22px;height:22px;border:3px solid #b8cfc2;border-top-color:var(--navy);border-radius:50%;animation:wf-spin .8s linear infinite}.wf-elapsed,.wf-wait-note{font-size:12px;margin-top:3px}.wf-feedback{white-space:pre-wrap;line-height:1.5;margin-top:8px}.wf-item:focus{outline:2px solid var(--navy);outline-offset:3px}.wf-diff details{margin-top:8px}.wf-diff pre{white-space:pre-wrap;font:inherit}.wf-text-draft{border-left:3px solid #9a6728;padding:12px;background:#fcf5e8;white-space:pre-wrap;margin:12px 0}.wf-no-change{padding:10px;background:#f3f5f3;border-radius:8px;line-height:1.5}@keyframes wf-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.wf-spinner{animation:none;border-style:dotted}}';
  document.head.appendChild(style);
  return {start:start, sync:sync, busy:function () { return active.size > 0; }};
})();

/* Hard-no decisions always explain the original risk before any approval request. */
window.WorkflowHardNoDialog = (function () {
  'use strict';
  var dismiss = null;
  function ask(row, item, options) {
    var afterRework = !!(options && options.afterRework), risky = item.classification === 'deal_breaker';
    if (dismiss) return Promise.resolve(null);
    var info = item.hardNoReview || {}, prior = info.original || item;
    var canApprove = (!risky || (info.baselineAvailable === true && !!info.token)) && !item.issue && Array.isArray(item.preview) && item.preview.length > 0 && (item.changes || []).length > 0;
    var opener = document.activeElement, dialog = document.createElement('dialog');
    dialog.className = 'wf-risk-dialog'; if (afterRework) dialog.dataset.reworkChoice = 'true'; dialog.setAttribute('aria-labelledby', 'wf-risk-title');
    dialog.setAttribute('aria-describedby', 'wf-risk-intro');
    function add(tag, text, parent, className) {
      var element = document.createElement(tag); element.textContent = text;
      if (className) element.className = className;
      (parent || dialog).appendChild(element); return element;
    }
    function block(title, text, parent) {
      var section = add('section', '', parent, 'wf-risk-block');
      add('h3', title, section); add('p', text || 'Ingen förklaring sparad. Begär en omarbetning innan du fattar beslut.', section); return section;
    }
    add('h2', afterRework ? 'Ny formulering – inför eller behåll originalet' : 'Hard no – granska risken och vårt alternativ').id = 'wf-risk-title';
    add('p', item.topic || 'Avvikelse', null, 'wf-risk-topic');
    if (afterRework) add('p', 'Det nya förslaget är sparat men har INTE införts. Jämför med vår befintliga lydelse och välj uttryckligen vad som ska användas.', null, 'wf-risk-intro').id = 'wf-risk-intro';
    if (risky) {
    add('p', 'Hard no gäller motpartens ursprungliga villkor. Ett nytt formuleringsförslag är inte automatiskt säkert eller godkänt. Granska vad som avviker från vår grund.', null, 'wf-risk-intro').id = afterRework ? 'wf-original-risk-intro' : 'wf-risk-intro';
    block(row.type === 'da' ? 'Leverantörens ursprungliga villkor' : 'Kundens ursprungliga villkor', prior.their);
    block('Varför detta inte rekommenderas', [prior.rationale, prior.legal].filter(Boolean).join('\n\n'));
    block('Vår position – granskningens sammanfattning', prior.our);
    var standard = add('details', '', null, 'wf-risk-standard');
    add('summary', 'Visa ärendets låsta Vendora-standard', standard);
    (info.baselineTargets || []).forEach(function (target) { block(target.label + ' · ' + target.id, target.text, standard); });
    add('pre', info.baselineText || 'Standardunderlaget saknas. Begär kontroll av ärendet.', standard);
    }
    if (canApprove) {
      add('h3', 'Det aktuella alternativet – inte infört');
      item.preview.forEach(function (change) {
        var box = add('section', '', null, 'wf-risk-diff');
        add('h4', change.label || change.target.id, box);
        block('Nuvarande lydelse i vårt avtal', change.oldText || 'Tomt fält', box);
        block('Ny lydelse som kan godkännas', change.newText || 'Texten tas bort', box);
      });
      if (item.rationale !== prior.rationale) block('Advokatens bedömning av alternativet', item.rationale);
    } else if (item.proposed) block('Textutkast – ännu inte en verifierad ändring', item.proposed);
    add('p', 'Att behålla vår lydelse lämnar det aktuella avtalet oförändrat; tidigare anpassningar återställs inte automatiskt till standard. En ny AI-formulering måste godkännas separat.', null, 'wf-note');
    var instruction = null;
    if (!afterRework) {
      var label = add('label', 'Önskemål till advokaten (valfritt att precisera)'); label.htmlFor = 'wf-risk-instruction';
      instruction = add('textarea', 'Utgå från vår låsta standard. Försök möta motpartens bakomliggande behov med minsta nödvändiga ändring utan att ge upp vårt grundskydd. Redovisa kvarvarande risker. Om det inte går, rekommendera att vår lydelse behålls.');
      instruction.id = 'wf-risk-instruction'; instruction.maxLength = 2000; instruction.rows = 4;
    }
    var actions = add('div', '', null, 'wf-risk-actions'), rework = null;
    if (!afterRework) { rework = add('button', 'Ta fram förslag närmare vår standard', actions, 'wf-risk-primary'); rework.dataset.riskAction = 'rework'; }
    var keep = add('button', afterRework ? 'Behåll originalet – vår befintliga lydelse' : 'Behåll vår lydelse', actions); keep.dataset.riskAction = 'keep';
    var close = add('button', afterRework ? 'Ta ställning senare' : 'Avbryt', actions); close.dataset.riskAction = 'cancel';
    var approve = null, checkbox = null, reason = null;
    if (canApprove) {
      var exceptional = add(afterRework ? 'section' : 'details', '', null, 'wf-risk-exception');
      add(afterRework ? 'h3' : 'summary', afterRework ? 'Inför det nya förslaget i vårt avtal' : 'Granska och godkänn det aktuella alternativet i stället', exceptional);
      add('p', info.requiresCounsel ? 'Dokumenterat särskilt godkännande krävs fortfarande före underskrift. Detta beslut ersätter inte den kontrollen.' : 'Du godkänner endast den exakta nya lydelsen ovan. Det är inte en underskrift eller motpartens acceptans. Befintliga signeringskontroller gäller fortfarande.', exceptional);
      if (risky) {
        var checkLabel = add('label', '', exceptional, 'wf-risk-confirm');
        checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.id = 'wf-risk-confirm'; checkLabel.appendChild(checkbox);
        checkLabel.appendChild(document.createTextNode(' Jag har granskat risken, vår standard och den föreslagna lydelsen.'));
        var reasonLabel = add('label', 'Motivering till att detta alternativ kan accepteras (minst 10 tecken)', exceptional); reasonLabel.htmlFor = 'wf-risk-reason';
        reason = add('textarea', '', exceptional); reason.id = 'wf-risk-reason'; reason.maxLength = 2000; reason.rows = 2;
      }
      approve = add('button', afterRework ? 'Inför det nya förslaget' : 'Godkänn den visade formuleringen', exceptional, 'wf-risk-primary'); approve.dataset.riskAction = 'accept'; approve.disabled = risky;
      function validate() { approve.disabled = risky && (!checkbox.checked || reason.value.trim().length < 10); }
      if (risky) { checkbox.onchange = validate; reason.oninput = validate; }
    }
    dialog.querySelectorAll('button').forEach(function (b) { b.type = 'button'; });
    document.body.appendChild(dialog);
    return new Promise(function (resolve) {
      var done = false;
      function finish(choice) {
        if (done) return; done = true; dismiss = null;
        if (dialog.open) dialog.close(); dialog.remove();
        if (opener && opener.isConnected) opener.focus({preventScroll:true});
        resolve(choice);
      }
      dismiss = function () { finish(null); };
      dialog.addEventListener('cancel', function (event) { event.preventDefault(); finish(null); });
      close.onclick = function () { finish(null); };
      keep.onclick = function () { finish({action:'keep'}); };
      if (rework) rework.onclick = function () {
        if (!instruction.value.trim()) { instruction.setCustomValidity('Beskriv önskad anpassning.'); instruction.reportValidity(); return; }
        finish({action:'rework', instruction:instruction.value.trim(), mode:'standard_alignment'});
      };
      if (instruction) instruction.oninput = function () { instruction.setCustomValidity(''); };
      if (approve) approve.onclick = function () {
        if (approve.disabled || (risky && (!checkbox.checked || reason.value.trim().length < 10))) return;
        finish({action:'accept', ...(risky ? {hardNoAcknowledgement:info.token, note:reason.value.trim()} : {})});
      };
      try { dialog.showModal(); var heading=dialog.querySelector('h2'); heading.tabIndex=-1; heading.focus({preventScroll:true}); dialog.scrollTop=0; }
      catch (_) { finish(null); }
    });
  }
  var style = document.createElement('style');
  style.textContent = '.wf-risk-dialog{box-sizing:border-box;width:min(860px,calc(100vw - 32px));max-height:calc(100vh - 48px);padding:28px;border:1px solid var(--border,#ccc);border-radius:16px;background:var(--card,#fffdfa);color:var(--text,#242424);overflow:auto}.wf-risk-dialog::backdrop{background:rgba(12,30,24,.56)}.wf-risk-dialog h2{font-size:23px;margin:0 0 8px}.wf-risk-dialog h3{font-size:15px;margin:0 0 6px}.wf-risk-dialog p{white-space:pre-wrap;line-height:1.55;margin:6px 0}.wf-risk-topic{font-weight:700}.wf-risk-intro{background:#fff0d9;border-left:4px solid #9d5523;padding:12px}.wf-risk-block{margin:16px 0}.wf-risk-standard,.wf-risk-exception{padding:12px;border:1px solid #d6d7d2;border-radius:8px;margin:16px 0}.wf-risk-dialog summary{cursor:pointer;font-weight:600}.wf-risk-standard pre{font:inherit;font-size:13px;white-space:pre-wrap;max-height:250px;overflow:auto}.wf-risk-diff{padding:12px;background:#f1f5f2;border-radius:8px}.wf-risk-dialog label{display:block;margin:14px 0 6px;font-size:14px}.wf-risk-dialog textarea{box-sizing:border-box;width:100%;font:inherit;font-size:14px;padding:10px;border:1px solid #b7bcb7;border-radius:8px;resize:vertical}.wf-risk-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:16px}.wf-risk-dialog button{padding:10px 14px;border:1px solid #abb5ad;border-radius:20px;cursor:pointer;background:#fffdfa;color:#173b2f}.wf-risk-dialog .wf-risk-primary{background:#173b2f;color:white}.wf-risk-dialog button:disabled{opacity:.45;cursor:not-allowed}.wf-risk-confirm input{width:auto;margin-right:8px}.wf-risk-dialog :focus-visible{outline:3px solid #45826e;outline-offset:2px}@media(max-width:600px){.wf-risk-dialog{padding:18px}.wf-risk-actions button{width:100%}}';
  document.head.appendChild(style);
  return {ask:ask, dismiss:function () { if (dismiss) dismiss(); }};
})();

/* Vendora-first workspace. Decisions are acknowledged only after a committed server response. */
(function(){
  'use strict';
  var current=null, busy=false, actionMessage='';
  var labels={deal_breaker:'Hard no',red_flag:'Röd flagga',negotiate:'Förhandlingsbart',acceptable:'Acceptabelt / likvärdigt',missing:'Saknas / saknar motsvarighet'};
  var order={deal_breaker:0,red_flag:1,negotiate:2,missing:3,acceptable:4};
  async function api(url,method,body){var r=await fetch(url,{method:method||'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});var j=await r.json();if(!r.ok){var err=new Error(j.error||'Begäran misslyckades.');err.explanation=j.explanation||'';throw err;}return j;}
  function uid(){return crypto.randomUUID();}
  function reset(){WorkflowHardNoDialog.dismiss();document.body.classList.remove('wf-case-open');current=null;window._aiMessages=[];window._aiReview=null;window._openProposals=[];window._reviewData=null;window._lastBuild=null;window._lawyerState=null;window._clauseOverrides={};}
  window.wfReset=reset;
  function adopt(row){
    if(current&&current.id!==row.id)reset();current=row;
    if(window._editing&&window._editing.id!==row.id)reset(),current=row;
    window._editing={id:row.id,type:row.type,base:row.data,status:row.status,revision:row.revision,workflow:!!row.state,signedAt:row.signedAt};
    window._lawyerState=row.data;window._clauseOverrides=row.data.clauseOverrides||{};
    // Opening or refreshing a saved agreement must reveal its own workspace, not
    // leave actionable controls in the default (or previously selected) hidden tab.
    switchTab(row.type==='da'?0:row.type==='ra'?1:2);
    hydrateForm(row.type,row.data);
    var bar=document.getElementById('editBar');if(bar)bar.style.display='flex';
    var saveStatus=document.getElementById('editBarStatus');if(saveStatus){saveStatus.textContent='Sparad version '+row.revision;saveStatus.style.color='var(--muted)';}
    var text=document.getElementById('editBarText');if(text)text.textContent='Avtal #'+row.id+' — '+(row.data.name||'Nytt utkast')+' — version '+row.revision;
    var select=document.getElementById('aiAgreementType');if(select)select.value=row.type==='da'?'distribution':'reseller';
    // The legacy sticky generation bar must not cover workflow decision buttons.
    // Keep it accessible at the end of the form; the workspace has its own export actions.
    document.body.classList.toggle('wf-case-open',!!row.state);
    render();return row;
  }
  async function refresh(id){var row=await api('/api/workflow/'+id);return adopt(row);}
  window.wfRefresh=refresh;
  window.wfEnsure=async function(type){
    if(!window._authUser||!window._archiveEnabled)throw new Error('Logga in för att spara och granska avtalet.');
    var e=window._editing;
    if(e&&e.type!==type)throw new Error('Avsluta det öppna avtalet innan du byter avtalstyp.');
    var data=Object.assign({},e&&e.base||{},readForm(type),{_type:type});
    if(!e){var made=await api('/api/agreements','POST',{type:type,data:data,counterpartyName:data.name||null,status:'draft'});e={id:made.id,type:type,base:data};window._editing=e;}
    else if(e.workflow){await api('/api/agreements/'+e.id,'PUT',{data:data,expectedRevision:e.revision});}
    else {await api('/api/agreements/'+e.id,'PUT',{data:data,counterpartyName:data.name||null});}
    return adopt(await api('/api/workflow/'+e.id+'/start','POST',{}));
  };
  function mount(type){var id='wf_panel_'+type,el=document.getElementById(id);if(!el){el=document.createElement('section');el.id=id;el.className='card';var slot=document.getElementById('cr_slot_'+type);if(slot)slot.appendChild(el);}return el;}
  function esc(s){return window.esc(s);}
  function line(label,text){return text?'<div class="wf-line"><strong>'+label+'</strong> '+esc(text)+'</div>':'';}
  function companyImportsHtml(row){
    var imports=row.state.companyImports||[],html='';
    imports.forEach(function(group){
      var pending=group.status==='pending',locked=['invited','pending_signature','vendora_signed','sent','signed'].includes(row.status)||!!row.state.reviewRunning;
      html+='<section class="wf-company wf-check" data-company="'+esc(group.id)+'"><h3>Företagsuppgifter från det uppladdade avtalet</h3>';
      html+=line('Identifierad motpart:',group.partyName)+line('Roll:',group.role==='supplier'?'Leverantör':group.role==='customer'?'Kund / återförsäljare':'Oklar');
      html+=line('Källa:',group.source.filename)+line('Partshänvisning:',group.sourceRef)+line('Källcitat för avtalsparten:',group.partyEvidence)+line('Kommentar:',group.note);
      html+='<p class="wf-note">Uppgifterna är hämtade ur dokumentet, inte verifierade mot ett bolagsregister. Endast markerade uppgifter förs in. Betalningsvillkor och Vendoras fakturaadress ändras inte.</p>';
      if(group.issue)html+=line('Kan inte importeras:',group.issue);
      if(!group.fields.length)html+='<p>Inga säkert identifierade företagsuppgifter finns att importera. Komplettera manuellt.</p>';
      group.fields.forEach(function(f){
        var same=String(f.previous).trim()===String(f.value).trim();
        html+='<div class="wf-diff"><label>';
        if(pending)html+='<input type="checkbox" data-company-field="'+esc(f.field)+'" '+(f.issue||group.issue||locked||same?'disabled':!f.previous.trim()&&f.confidence==='high'&&f.sourceVerified?'checked':'')+'> ';
        html+='<strong>'+esc(f.label)+'</strong></label>';
        html+=line('Befintligt värde:',f.previous||'—')+line('Hämtat värde:',f.value)+line('Källhänvisning:',f.sourceRef)+line('Källcitat:',f.evidence);
        if(f.issue)html+='<p class="wf-warning">'+esc(f.issue)+'</p>';
        else if(!f.sourceVerified||f.confidence!=='high')html+='<p class="wf-warning">Kontrollera i originalet: '+(!f.sourceVerified?'PDF-citatet är inte maskinellt textverifierat.':'AI:n har markerat uppgiften som osäker.')+'</p>';
        if(pending&&f.previous.trim()&&!same)html+='<p class="wf-warning">Ett befintligt värde skiljer sig. Markera endast för en avsiktlig ersättning.</p>';
        if(!pending)html+='<p class="wf-note">'+(f.status==='imported'?'Infört och sparat':'Befintlig uppgift behålls')+'</p>';
        html+='</div>';
      });
      if(pending){
        html+='<label><input type="checkbox" data-company-confirm '+(group.issue||locked?'disabled':'')+'> Jag har kontrollerat att uppgifterna avser rätt juridisk avtalspart.</label>';
        html+='<div class="wf-actions"><button data-wf="company-apply" '+(group.issue||locked?'disabled':'')+'>För in markerade uppgifter i vårt avtal</button><button data-wf="company-skip" '+(locked?'disabled':'')+'>Behåll befintliga uppgifter / avstå import</button></div>';
      } else if(group.decidedBy)html+='<p class="wf-note">Beslut sparat av '+esc(group.decidedBy)+'</p>';
      html+='</section>';
    });return html;
  }
  function render(){if(!current||!current.state)return;var row=current,el=mount(row.type),s=row.state;if(!el)return;
    var pending=s.items.filter(i=>i.status==='pending'),companyPending=(s.companyImports||[]).some(i=>i.status==='pending'),stage=['pending_signature','vendora_signed','signed'].indexOf(row.status)>=0?5:row.status==='sent'?4:row.status==='submitted'?3:row.status==='invited'?2:1;
    var steps=['1. Jämför och anpassa','2. Kundens komplettering','3. Granska återkoppling','4. Motpartens underskrift','5. Vendoras underskrift'];
    var html='<div class="wf-progress">'+steps.map((x,i)=>'<span'+(stage===i+1?' aria-current="step"':'')+'>'+x+'</span>').join('')+'</div>';
    html+='<h2>Vårt avtal · version '+row.revision+'</h2><p>Godkända anpassningar ändrar endast detta avtal. Standardmallen och kundens original lämnas orörda.</p>';
    if(s.reviewRunning)html+='<div class="wf-activity" role="status"><span class="wf-spinner" aria-hidden="true"></span><div><strong>AI-granskningen pågår</strong><p>Resultatet är inte klart. Inga ändringar har godkänts ännu.</p></div></div>';
    html+='<div class="wf-actions"><button data-wf="download">Ladda ned vårt avtal</button><button data-wf="redline">Word med ändringsmarkeringar</button>';
    // Signing order: approve & send → the counterparty signs and uploads → Vendora's CEO countersigns.
    if(!['sent','pending_signature','vendora_signed','signed'].includes(row.status))html+='<button data-wf="invite" '+(pending.length||companyPending||s.reviewRunning?'disabled':'')+'>Skicka till kunden för granskning</button><button data-wf="signature" '+(row.signatureProblems.length||row.status==='invited'?'disabled':'')+'>Godkänn och skicka för underskrift</button>';
    if(row.status==='invited')html+='<button data-wf="withdraw">Återkalla kundlänken för omarbetning</button>';
    if(row.status==='sent')html+='<button data-wf="signview">Visa utskicket</button><button data-wf="upload-signed">Registrera signerad kopia (mottagen via mejl)</button><button data-wf="remind">Påminn motparten</button><button data-wf="withdraw">Återkalla utskicket</button>';
    if(row.status==='pending_signature')html+='<button data-wf="signview">'+(window._isSigner?'Granska och skriv under':'Visa motpartens underskrift')+'</button>';
    if(row.status==='signed'||row.status==='vendora_signed')html+='<button data-wf="signview">Visa underskrifterna</button>';
    html+='</div><div id="wf_message" role="status" aria-live="polite"></div>';
    var signerName=window._signerName||'VD';
    if(row.status==='sent')html+='<p class="wf-note">Skickat för underskrift till '+esc(row.signatureEmail||'')+(row.signatureSentAt?' · '+esc(fmtWhen(row.signatureSentAt)):'')+(s.signatureShare&&s.signatureShare.delivery==='failed'?'. E-posten kunde inte skickas: öppna "Visa utskicket" och skicka länken manuellt':'')+'. Avtalet är låst tills motparten signerat och '+esc(signerName)+' skrivit under.</p>';
    if(row.counterparty)html+='<p class="wf-note">Signerat för motparten av '+esc(row.counterparty.by||'')+' · '+esc(fmtWhen(row.counterparty.signedAt))+(row.status==='pending_signature'?'. Väntar på '+esc(signerName)+'s underskrift.':'')+'</p>';
    if(row.signedAt)html+='<p class="wf-note">Undertecknat för Vendora av '+esc(row.signedBy||signerName)+' · '+esc(fmtWhen(row.signedAt))+'. Motparten har fått en länk till det signerade avtalet.</p>';
    html+=companyImportsHtml(row);
    if(row.signatureProblems.length)html+='<details class="wf-check"><summary>Kvar före slutgodkännande ('+row.signatureProblems.length+')</summary><p>'+row.signatureProblems.map(p=>esc(p.replace(/Saknad uppgift: (\w+)/g,(_,k)=>'Saknad uppgift: '+({name:'företagsnamn',reg:'organisations-/registreringsnummer',country:'registreringsland',addr:'registrerad adress',sig_name:'undertecknarens namn',sig_email:'undertecknarens e-post'}[k]||k)))).join('<br>')+'</p>'+(window._isAdmin&&s.items.some(i=>i.status==='accepted'&&i.requiresCounsel)?'<button data-wf="counsel">Dokumentera särskilt godkännande</button>':'')+'</details>';
    if(s.sent)html+='<p class="wf-note">Senast utskickad version: '+s.sent.version+' · E-post: '+esc(s.sent.delivery==='sent'?'skickad':s.sent.delivery==='failed'?'kunde inte skickas':'inte bekräftad')+'. Kundens villkorsförslag ändrar inte avtalet automatiskt.</p>';
    html+='<h3>'+(s.reviewRunning?'Inväntar granskningsresultat':pending.length+' punkter väntar på beslut')+'</h3>';
    s.items.slice().sort((a,b)=>(a.status==='pending'?0:1)-(b.status==='pending'?0:1)||(order[a.classification]||0)-(order[b.classification]||0)).forEach(function(item){
      html+='<article class="wf-item" data-item="'+esc(item.id)+'" tabindex="-1"><div class="wf-item-title"><strong>'+esc(item.topic)+'</strong><span>'+esc(labels[item.classification]||'Förslag')+'</span></div>';
      html+=line(row.type==='da'?'Leverantörens villkor:':'Kundens villkor:',item.their)+line('Vår position:',item.our)+line('Advokatens bedömning:',item.rationale);
      if(item.source==='customer')html+='<p class="wf-note">Kundens eget förslag. Ingen automatisk AI-rekommendation. Bearbeta med advokaten för ett alternativ.</p>';
      var hasChanges=Array.isArray(item.changes)&&item.changes.length>0;
      var hasPreview=Array.isArray(item.preview)&&item.preview.length>0;
      var canApply=hasChanges&&hasPreview&&!item.issue;
      var locked=['invited','pending_signature','vendora_signed','sent','signed'].includes(row.status)||!!s.reviewRunning;
      if(hasPreview)html+='<div class="wf-diff"><strong>Föreslagen ändring i vårt avtal</strong>'+item.preview.map(p=>'<div><strong>'+esc(p.label||p.target.id)+'</strong><div>'+redlineHtml(p.oldText,p.newText)+'</div><details><summary>Visa fullständig lydelse före och efter</summary><p><strong>Nuvarande lydelse</strong></p><pre>'+esc(p.oldText)+'</pre><p><strong>Ny lydelse som godkänns</strong></p><pre>'+esc(p.newText)+'</pre></details></div>').join('')+'</div>';
      if(!canApply&&item.proposed)html+='<div class="wf-text-draft"><strong>Textutkast – inte infört i avtalet</strong><div>'+esc(item.proposed)+'</div></div>';
      if(item.requiresCounsel&&canApply)html+='<p class="wf-warning">Om ändringen införs krävs även dokumenterat särskilt godkännande före underskrift.</p>';
      if(item.status==='pending'){
        if(!hasChanges)html+='<p class="wf-no-change">'+(item.proposed?'Det finns ett textutkast, men ännu ingen exakt koppling till en klausul i vårt avtal. Skapa ett tillämpbart förslag innan texten kan godkännas.':'Ingen ny lydelse har föreslagits. Du kan godkänna att vår befintliga text behålls, eller be advokaten ta fram ett alternativ.')+'</p>';
        if(item.issue)html+='<p class="wf-warning">Förslaget kan inte införas: '+esc(item.issue)+'</p>';
        if(hasChanges&&!hasPreview&&!item.issue)html+='<p class="wf-warning">Förslaget saknar en verifierad förhandsvisning. Bearbeta det innan godkännande.</p>';
        html+='<div class="wf-actions">';
        if(canApply)html+='<button data-wf="accept" '+(locked?'disabled':'')+'>'+(item.classification==='deal_breaker'?'Granska risk och godkänn':'Godkänn '+(item.source==='customer'?'kundens förslag':'föreslagen formulering'))+'</button>';
        html+='<button data-wf="keep" '+(locked?'disabled':'')+'>'+(hasChanges?'Avslå / behåll vår lydelse':'Godkänn att vår lydelse behålls')+'</button><button data-wf="rework" '+(locked?'disabled':'')+'>'+(item.classification==='deal_breaker'?'Förklaring / anpassa mot vår standard':!hasChanges?(item.proposed?'Skapa tillämpbart ändringsförslag':'Ta fram alternativ formulering'):item.issue?'Bearbeta och rätta förslaget':'Bearbeta med avtalsadvokaten')+'</button></div>';
      }
      else html+='<p class="wf-note">'+esc(item.status==='accepted'?'Godkänt och sparat':item.status==='kept'?'Vår lydelse behålls':'Ersatt av ett nytt förslag')+(item.decidedBy?' · '+esc(item.decidedBy):'')+'</p>';
      html+='<div class="wf-item-feedback wf-feedback" role="status" aria-live="polite"></div></article>';
    });
    el.innerHTML=html;
    WorkflowActivity.sync();
    el.querySelectorAll('[data-wf]').forEach(function(btn){btn.onclick=async function(){if(busy||WorkflowActivity.busy())return;busy=true;actionMessage='';var action=btn.dataset.wf,article=btn.closest('[data-item]'),id=article&&article.dataset.item;
      var feedback=null,newItemId=null,wasDisabled=btn.disabled;
      function localHost(){var panel=document.getElementById('wf_panel_'+row.type);return id&&panel?Array.from(panel.querySelectorAll('[data-item]')).find(x=>x.dataset.item===id)?.querySelector('.wf-item-feedback'):panel&&panel.querySelector('#wf_message');}
      try{
        var riskChoice=null, selectedItem=current&&current.state.items.find(function (item) { return item.id===id; });
        if(selectedItem&&selectedItem.classification==='deal_breaker'&&['accept','rework'].includes(action)){
          var displayedRevision=current.revision,displayedId=current.id;
          riskChoice=await WorkflowHardNoDialog.ask(current,selectedItem);
          if(!riskChoice)return;
          if(!current||current.id!==displayedId||current.revision!==displayedRevision)throw new Error('Avtalet har ändrats medan riskdialogen var öppen. Granska den senaste versionen på nytt.');
          action=riskChoice.action;
        }
        if(['accept','keep','company-apply','company-skip'].includes(action))feedback=WorkflowActivity.start('workflow:'+row.id,localHost,'Bearbetar och sparar…');
        else if(action!=='rework')btn.disabled=true;
        if(action==='company-apply'||action==='company-skip'){
          var groupEl=btn.closest('[data-company]'),fields=action==='company-apply'?Array.from(groupEl.querySelectorAll('[data-company-field]:checked')).map(x=>x.dataset.companyField):[];
          var confirmed=!!groupEl.querySelector('[data-company-confirm]:checked'),importId=groupEl.dataset.company;
          if(action==='company-apply'&&(!confirmed||!fields.length))throw new Error('Bekräfta rätt avtalspart och markera de uppgifter som ska föras in.');
          // Save visible manual edits first; stale extraction targets then fail safely on the server.
          await window.wfEnsure(row.type);
          adopt(await api('/api/workflow/'+row.id+'/company-details','POST',{importId:importId,action:action==='company-apply'?'apply':'skip',fields:fields,confirmedParty:confirmed,expectedRevision:current.revision,requestId:uid()}));
          message(action==='company-apply'?'Markerade företagsuppgifter är införda och sparade i vårt avtal.':'Befintliga företagsuppgifter behålls.');
        }
        else if(action==='accept'||action==='keep')adopt(await api('/api/workflow/'+row.id+'/decisions','POST',{itemId:id,action:action,expectedRevision:current.revision,requestId:uid(),...(riskChoice&&action==='accept'?{hardNoAcknowledgement:riskChoice.hardNoAcknowledgement,note:riskChoice.note}:{})}));
        else if(action==='rework'){
          var note=riskChoice?riskChoice.instruction:prompt('Vad ska advokaten tillmötesgå eller förtydliga?', 'Föreslå en konkret formulering i vårt avtal som möter motpartens behov utan att ge upp vårt grundskydd.');
          if(note&&note.trim()){
            feedback=WorkflowActivity.start('workflow:'+row.id,localHost,'Sparar underlaget för omarbetningen…');
            await window.wfEnsure(row.type);
            feedback.stage('Avtalsadvokaten tar fram ett nytt formuleringsförslag…');
            var changed=await api('/api/workflow/'+row.id+'/rework','POST',{itemId:id,instruction:note.trim(),expectedRevision:current.revision,...(riskChoice?{mode:'standard_alignment'}:{})});
            newItemId=changed.reworkedItemId;
            if(current&&current.id===row.id)adopt(changed);
            feedback.finish('Nytt förslag är sparat. Granska den nya lydelsen och godkänn den separat.');feedback=null;
            var target=Array.from(el.querySelectorAll('[data-item]')).find(x=>x.dataset.item===newItemId);
            if(target){target.scrollIntoView({block:'center',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});target.focus({preventScroll:true});}
            // Generation never means consent. Ask immediately, using the saved
            // preview/version; closing leaves the new alternative pending.
            if (current && current.id === row.id) {
              var offered = current.state.items.find(x=>x.id===newItemId), offeredRevision = current.revision;
              if (offered) {
                var choice = await WorkflowHardNoDialog.ask(current, offered, {afterRework:true});
                if (choice) {
                  if (!current || current.id!==row.id || current.revision!==offeredRevision) throw new Error('Avtalet har ändrats medan förslaget visades. Granska den senaste versionen på nytt.');
                  id = newItemId;
                  feedback = WorkflowActivity.start('workflow:'+row.id,localHost,'Sparar ditt val…');
                  var decided = await api('/api/workflow/'+row.id+'/decisions','POST',{itemId:newItemId,action:choice.action,expectedRevision:offeredRevision,requestId:uid(),...(choice.hardNoAcknowledgement?{hardNoAcknowledgement:choice.hardNoAcknowledgement,note:choice.note}:{})});
                  if (current && current.id===row.id) adopt(decided);
                  actionMessage = choice.action==='accept' ? 'Den nya formuleringen är införd och sparad.' : 'Originalet behålls. Det nya förslaget har inte införts.';
                }
              }
            }
          }
        }
        else if(action==='download'||action==='redline'){var data=JSON.parse(JSON.stringify(current.data));data._trackChanges=action==='redline';await downloadAgreementData(current.type,data);}
        else if(action==='invite')await invite(row.type);
        else if(action==='signature'){await window.wfEnsure(row.type);sendForSignature(current.id);}
        else if(action==='signview')openSigningView(row.id);
        else if(action==='withdraw'){if(confirm(row.status==='sent'?'Återkalla utskicket? Motpartens signeringslänk slutar fungera och avtalet öppnas för omarbetning.':'Återkalla kundlänken och öppna avtalet för omarbetning?')){await api('/api/agreements/'+row.id+'/withdraw','POST',{expectedRevision:current.revision});await refresh(row.id);}}
        else if(action==='upload-signed')uploadSignedCopy(row);
        else if(action==='remind'){var reminder=await api('/api/agreements/'+row.id+'/remind','POST',{});message(reminder.sent?'Påminnelse skickad till motparten.':'Påminnelsen kunde inte skickas: '+(reminder.reason||'e-post är inte konfigurerad'),!reminder.sent);}
        else if(action==='counsel'){var approval=prompt('Vem har granskat och godkänt riskvillkoren? Ange en dokumenthänvisning.');if(approval)adopt(await api('/api/workflow/'+row.id+'/counsel-approval','POST',{note:approval,expectedRevision:current.revision}));}
      }catch(e){
        // Keep the error beside the clicked proposal, even after re-rendering its server state.
        if(current&&current.id===row.id){try{await refresh(row.id);}catch(_){} }
        var failure=e.message+(e.explanation?'\n\nAdvokatens svar: '+e.explanation:'');
        if(feedback){feedback.finish(failure,true);feedback=null;}else message(failure,true);
      }finally{
        busy=false;
        if(!feedback&&btn.isConnected)btn.disabled=wasDisabled;
        if(feedback)feedback.finish(action==='accept'?'Godkänt och sparat.':action==='keep'?'Beslut sparat. Vår befintliga lydelse behålls.':actionMessage);
      }};});
  }
  function message(text,bad){actionMessage=text;var el=document.getElementById('wf_message');if(el){el.textContent=text;el.className=bad?'wf-warning':'wf-note';}else alert(text);}
  function fmtWhen(iso){return iso?String(iso).slice(0,16).replace('T',' '):'';}
  // The counterparty's signed copy came by email instead of through their link: the seller uploads it
  // here and the agreement moves on to the CEO. Not awaited by the click handler, since a cancelled
  // file dialog never fires change.
  function uploadSignedCopy(row){
    var input=document.createElement('input');input.type='file';input.accept='.pdf,.docx,.doc,.png,.jpg,.jpeg';
    input.onchange=async function(){
      var file=input.files&&input.files[0];if(!file)return;
      try{
        if(window.UploadLimits&&file.size>window.UploadLimits.MAX_FILE_BYTES)throw new Error('Filen är större än '+window.UploadLimits.MAX_FILE_LABEL+'.');
        var signer=prompt('Vem har signerat för motparten? (namn)',row.data.sig_name||'');if(!signer||!signer.trim())return;
        var r=await fetch('/api/agreements/'+row.id+'/files',{method:'POST',headers:{'Content-Type':file.type||'application/octet-stream','X-Filename':encodeURIComponent(file.name),'X-Signer-Name':encodeURIComponent(signer.trim())},body:file});
        var j=await r.json();if(!r.ok)throw new Error(j.error||'Uppladdningen misslyckades.');
        await refresh(row.id);message('Motpartens signerade kopia är registrerad. '+(window._signerName||'VD')+' har fått en begäran om underskrift.');
      }catch(e){message(e.message,true);}
    };
    input.click();
  }
  async function invite(type){
    var email=gv(type+'_inv_email')||(current&&current.state.sent&&current.state.sent.email)||'';if(!email)email=prompt('Kundens e-postadress:')||'';if(!email)return;
    var row=await window.wfEnsure(type);
    var result=await api('/api/workflow/'+row.id+'/invite','POST',{email:email,expectedRevision:row.revision,requestId:uid()});adopt(result);
    message(result.sent?'Avtalet med godkända anpassningar har skickats till kunden.':'E-posten kunde inte skickas. Avtalsversionen är sparad; länken nedan kan skickas manuellt.',!result.sent);
    if(!result.sent){var a=document.createElement('a');a.href=result.inviteUrl;a.textContent='Öppna kundens granskningslänk';a.target='_blank';a.rel='noopener';document.getElementById('wf_message').appendChild(document.createElement('br'));document.getElementById('wf_message').appendChild(a);}
  }
  window.wfInvite=invite;
  window.wfDecisionRefresh=function(){if(window._editing&&window._editing.workflow)return refresh(window._editing.id);return Promise.resolve();};
  // Start straight from a saved archive record, including links sent after customer submission.
  async function openHash(){var m=location.hash.match(/^#workflow=(\d+)$/);if(!m)return;try{var u=await api('/api/auth/me');window._authUser=u.user;window._archiveEnabled=true;window._isAdmin=!!u.user.isAdmin;window._isSigner=!!u.user.isSigner;var row=await api('/api/workflow/'+m[1]);switchTab(row.type==='da'?0:row.type==='ra'?1:2);adopt(row);}catch(e){alert('Logga in och öppna avtalet i arkivet. '+e.message);}}
  // The counterparty's page (#agreementcopy=id.token): download the frozen agreement, upload the
  // signed copy, and later download the fully signed version. Public and in English; no sign-in.
  async function copyView(){var m=location.hash.match(/^#agreementcopy=(\d+)\.([A-Za-z0-9_-]+)$/);if(!m)return;
    var shell=document.querySelector('.shell');['.topbar','.tabs','.genbar'].forEach(function(sel){var hidden=document.querySelector(sel);if(hidden)hidden.style.display='none';});
    function el(tag,text,cls){var n=document.createElement(tag);if(text)n.textContent=text;if(cls)n.className=cls;return n;}
    function when(iso){return iso?String(iso).slice(0,16).replace('T',' ')+' UTC':'';}
    async function load(){paint(await api('/api/public-agreements/'+m[1]+'?token='+encodeURIComponent(m[2])));}
    function paint(v){
      shell.textContent='';var card=el('section','','card wf-public');card.setAttribute('data-public-status',v.status);
      var type=v.type==='da'?'Distributor Agreement':'Reseller Agreement';
      card.appendChild(el('div','Vendora Nordic AB','wf-public-kicker'));
      card.appendChild(el('h2',type+' — '+(v.name||'')+(v.version?' · version '+v.version:'')));
      var download=el('button',v.status==='signed'?'Download the signed agreement (.docx)':'Download the agreement (.docx)','wf-public-primary');download.type='button';download.id='wf-public-download';
      download.onclick=function(){downloadAgreementData(v.type,JSON.parse(JSON.stringify(v.data)));};
      var cs=v.data._counterpartySignature&&v.data._counterpartySignature.at?v.data._counterpartySignature:null;
      function signatureLine(prefix){var who=(cs?cs.name+(cs.title?', '+cs.title:''):(v.counterparty&&v.counterparty.by)||'');var how=cs?' electronically':(v.counterparty&&v.counterparty.filename?' ('+v.counterparty.filename+')':'');return prefix+who+how+(v.counterparty?' on '+when(v.counterparty.signedAt):'');}
      function signatureImage(){if(!cs||!cs.image||!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(cs.image))return null;var img=document.createElement('img');img.src=cs.image;img.alt='Drawn signature';img.className='wf-sign-image';return img;}
      if(v.status==='sent'){
        card.appendChild(el('p','Vendora Nordic AB has approved the final version of this agreement. Please download it and give it a final check, then sign below. Vendora\'s CEO countersigns, and you will receive an email with the fully signed agreement ready for download.'));
        card.appendChild(download);
        // Electronic signature: the primary way to sign.
        var sign=el('div','','wf-public-sign');sign.appendChild(el('h3','Sign electronically'));
        sign.appendChild(el('p','Type your name and title, draw your signature if you like, and confirm. Your name, title, email, the time, your IP address and the exact version you sign are recorded, and your signature appears in the agreement\'s signature block. This is an electronic signature (eIDAS); no printing needed.','wf-note'));
        function field(id,label,value,type){var l=el('label',label);l.htmlFor=id;sign.appendChild(l);var i=document.createElement('input');i.id=id;i.type=type||'text';i.maxLength=200;i.value=value||'';sign.appendChild(i);return i;}
        var sName=field('wf-sign-name','Full name',v.data.sig_name),sTitle=field('wf-sign-title','Title / position',v.data.sig_title),sEmail=field('wf-sign-email','Email',v.data.sig_email,'email');
        var padLabel=el('label','Signature (draw with your mouse or finger — optional)');padLabel.htmlFor='wf-sign-pad';sign.appendChild(padLabel);
        var pad=document.createElement('canvas');pad.id='wf-sign-pad';pad.width=720;pad.height=220;pad.className='wf-sign-pad';pad.setAttribute('role','img');pad.setAttribute('aria-label','Signature pad');sign.appendChild(pad);
        var tools=el('div','','wf-sign-tools');var clear=el('button','Clear','wf-public-secondary');clear.type='button';clear.id='wf-sign-clear';tools.appendChild(clear);sign.appendChild(tools);
        var drawn=false,drawing=false,ctx=pad.getContext('2d');ctx.lineWidth=3;ctx.lineCap='round';ctx.lineJoin='round';ctx.strokeStyle='#15302a';
        function pos(ev){var r=pad.getBoundingClientRect();return {x:(ev.clientX-r.left)*pad.width/r.width,y:(ev.clientY-r.top)*pad.height/r.height};}
        pad.addEventListener('pointerdown',function(ev){drawing=true;drawn=true;try{pad.setPointerCapture(ev.pointerId);}catch(_){}var p0=pos(ev);ctx.beginPath();ctx.moveTo(p0.x,p0.y);ctx.lineTo(p0.x+0.1,p0.y+0.1);ctx.stroke();ev.preventDefault();});
        pad.addEventListener('pointermove',function(ev){if(!drawing)return;var p1=pos(ev);ctx.lineTo(p1.x,p1.y);ctx.stroke();ev.preventDefault();});
        function stop(){drawing=false;}pad.addEventListener('pointerup',stop);pad.addEventListener('pointercancel',stop);pad.addEventListener('pointerleave',stop);
        clear.onclick=function(){ctx.clearRect(0,0,pad.width,pad.height);drawn=false;};
        var confirmLabel=el('label','','wf-sign-confirm');var confirmBox=document.createElement('input');confirmBox.type='checkbox';confirmBox.id='wf-sign-confirm';confirmLabel.appendChild(confirmBox);
        confirmLabel.appendChild(document.createTextNode(' I am authorised to sign on behalf of '+(v.name||'the counterparty')+', I have read the agreement'+(v.version?' (version '+v.version+')':'')+' and I agree to be bound by it. I understand that this is an electronic signature.'));sign.appendChild(confirmLabel);
        var signBtn=el('button','Sign the agreement','wf-public-primary');signBtn.type='button';signBtn.id='wf-sign-submit';sign.appendChild(signBtn);
        var signStatus=el('p','','wf-note');signStatus.id='wf-sign-status';signStatus.setAttribute('role','status');signStatus.setAttribute('aria-live','polite');sign.appendChild(signStatus);
        signBtn.onclick=async function(){
          if(sName.value.trim().length<2){signStatus.textContent='Enter the full name of the person signing.';signStatus.className='wf-warning';return;}
          if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sEmail.value.trim())){signStatus.textContent='Enter the signer\'s email address.';signStatus.className='wf-warning';return;}
          if(!confirmBox.checked){signStatus.textContent='Tick the confirmation to sign.';signStatus.className='wf-warning';return;}
          signBtn.disabled=true;signStatus.className='wf-note';signStatus.textContent='Recording your signature…';
          try{
            var body={name:sName.value.trim(),title:sTitle.value.trim(),email:sEmail.value.trim(),confirmed:true};if(drawn)body.image=pad.toDataURL('image/png');
            var r=await fetch('/api/public-agreements/'+m[1]+'/sign?token='+encodeURIComponent(m[2]),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
            var j=await r.json();if(!r.ok)throw new Error(j.error||'The signature could not be recorded. Please try again.');
            await load();
          }catch(err){signBtn.disabled=false;signStatus.textContent=err.message;signStatus.className='wf-warning';}
        };
        card.appendChild(sign);
        // Paper alternative: print, sign, upload.
        var alt=document.createElement('details');alt.className='wf-public-upload';alt.id='wf-public-paper';var summary=el('summary','Prefer to sign on paper? Print, sign and upload the signed copy instead.');alt.appendChild(summary);
        var form=el('div','');
        var nameLabel=el('label','Name of the person who signed');nameLabel.htmlFor='wf-signer-name';form.appendChild(nameLabel);
        var name=document.createElement('input');name.id='wf-signer-name';name.type='text';name.maxLength=200;name.value=v.data.sig_name||'';form.appendChild(name);
        var fileLabel=el('label','Signed agreement (PDF, Word, PNG or JPEG, up to '+(window.UploadLimits?window.UploadLimits.MAX_FILE_LABEL:'50 MB')+')');fileLabel.htmlFor='wf-signed-file';form.appendChild(fileLabel);
        var file=document.createElement('input');file.id='wf-signed-file';file.type='file';file.accept='.pdf,.docx,.doc,.png,.jpg,.jpeg';form.appendChild(file);
        var send=el('button','Upload signed copy','wf-public-primary');send.type='button';send.id='wf-upload-signed';form.appendChild(send);
        var status=el('p','','wf-note');status.id='wf-public-status';status.setAttribute('role','status');status.setAttribute('aria-live','polite');form.appendChild(status);
        send.onclick=async function(){
          var f=file.files&&file.files[0];
          if(!name.value.trim()){status.textContent='Enter the name of the person who signed.';status.className='wf-warning';return;}
          if(!f){status.textContent='Choose the signed file first.';status.className='wf-warning';return;}
          if(window.UploadLimits&&f.size>window.UploadLimits.MAX_FILE_BYTES){status.textContent='The file is larger than '+window.UploadLimits.MAX_FILE_LABEL+'.';status.className='wf-warning';return;}
          send.disabled=true;status.className='wf-note';status.textContent='Uploading…';
          try{
            var r=await fetch('/api/public-agreements/'+m[1]+'/signed-copy?token='+encodeURIComponent(m[2]),{method:'POST',headers:{'Content-Type':f.type||'application/octet-stream','X-Filename':encodeURIComponent(f.name),'X-Signer-Name':encodeURIComponent(name.value.trim())},body:f});
            var j=await r.json();if(!r.ok)throw new Error(j.error||'The upload failed. Please try again.');
            await load();
          }catch(e){send.disabled=false;status.textContent=e.message;status.className='wf-warning';}
        };
        alt.appendChild(form);card.appendChild(alt);
      }else if(v.status==='pending_signature'){
        card.appendChild(el('p','Thank you. '+signatureLine('Signed for '+(v.name||'the counterparty')+' by ')+'. Vendora\'s CEO is countersigning; you will receive an email when the fully signed agreement is ready for download.','wf-public-ok'));
        var drawnNow=signatureImage();if(drawnNow)card.appendChild(drawnNow);
        card.appendChild(download);
      }else{
        card.appendChild(el('p','This agreement is signed by both parties.','wf-public-ok'));
        var list=el('ul','','wf-public-signatures');
        if(v.counterparty)list.appendChild(el('li',signatureLine('Signed for '+(v.name||'the counterparty')+' by ')));
        if(v.vendora)list.appendChild(el('li','Signed for Vendora Nordic AB by '+(v.vendora.by||'')+', '+(v.vendora.title||'CEO')+', on '+when(v.vendora.signedAt)));
        card.appendChild(list);
        var drawnDone=signatureImage();if(drawnDone)card.appendChild(drawnDone);
        card.appendChild(el('p','Download your copy below. Both signatures are stamped in the signature block.'));
        card.appendChild(download);
      }
      card.appendChild(el('p','Questions? Reply to the email you received from Vendora.','wf-note'));
      shell.appendChild(card);
    }
    try{await load();}catch(e){shell.textContent='';var card=el('section','','card wf-public');card.appendChild(el('h2','This link is not available'));card.appendChild(el('p',e.message));shell.appendChild(card);}
  }
  window.addEventListener('hashchange',openHash);window.addEventListener('hashchange',copyView);openHash();copyView();
  var publicStyle=document.createElement('style');publicStyle.textContent='.wf-public{max-width:720px;margin:30px auto}.wf-public-kicker{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)}.wf-public-upload{margin-top:22px;padding-top:16px;border-top:1px solid var(--border)}.wf-public-upload label{display:block;margin:12px 0 6px;font-size:13px}.wf-public-upload input[type=text]{width:100%;max-width:420px;padding:9px 10px;border:1px solid var(--border);border-radius:8px;font:inherit;box-sizing:border-box}.wf-public-primary{display:block;margin-top:12px;padding:10px 18px;cursor:pointer}.wf-public-ok{background:#e6f2ea;border:1px solid #b7dfc3;border-radius:8px;padding:12px 14px;line-height:1.5}.wf-public-signatures{margin:10px 0 0 18px;line-height:1.6}.wf-public-sign{margin-top:22px;padding-top:16px;border-top:1px solid var(--border)}.wf-public-sign label{display:block;margin:12px 0 6px;font-size:13px}.wf-public-sign input[type=text],.wf-public-sign input[type=email]{width:100%;max-width:420px;padding:9px 10px;border:1px solid var(--border);border-radius:8px;font:inherit;box-sizing:border-box}.wf-sign-pad{display:block;width:100%;max-width:480px;height:auto;background:#fff;border:1px dashed #9aa5a0;border-radius:8px;touch-action:none;cursor:crosshair}.wf-sign-tools{margin-top:6px}.wf-public-secondary{padding:6px 12px;cursor:pointer}.wf-sign-confirm{display:flex;gap:8px;align-items:flex-start;line-height:1.5;margin-top:14px;font-size:13px}.wf-sign-confirm input{margin-top:3px;flex:none}.wf-public-upload summary{cursor:pointer;font-weight:600;margin-bottom:6px}.wf-sign-image{display:block;max-height:60px;background:#fff;border:1px solid var(--border);border-radius:6px;padding:4px 8px;margin-top:8px}';document.head.appendChild(publicStyle);
  var style=document.createElement('style');style.textContent='.wf-progress{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:18px}.wf-progress span{padding:8px 12px;border:1px solid var(--border);border-radius:20px;font-size:12px}.wf-progress [aria-current]{background:var(--navy);color:#fff}.wf-item{border:1px solid var(--border);border-radius:10px;padding:18px;margin-top:14px}.wf-item-title{display:flex;gap:15px;justify-content:space-between}.wf-item-title span{font-size:12px;font-weight:600}.wf-line{margin-top:10px;white-space:pre-wrap;line-height:1.5}.wf-diff{padding:12px;margin:12px 0;background:#f7f8fa;white-space:pre-wrap;line-height:1.6}.wf-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}.wf-actions button{padding:8px 13px;cursor:pointer}.wf-actions button:disabled{opacity:.45;cursor:not-allowed}.wf-note{font-size:12px;line-height:1.5;color:var(--muted);margin-top:12px}.wf-warning{color:#964514;font-size:13px;margin:12px 0}.wf-check{margin:14px 0;padding:12px;background:#f8f0df}';document.head.appendChild(style);
})();

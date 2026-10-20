// Visible feedback starts before the first await and survives workspace re-renders.
// Elapsed time is not a percentage or a claim about model-internal progress.
window.WorkflowActivity = (function () {
  'use strict';
  var active = new Map();
  var originals = new Map();
  var selectors = '[data-wf], [id^="cr_btn_"], [id^="cr_file_"], #editBar button, .tabs button, .tab-panel input, .tab-panel select, .tab-panel textarea';
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
  style.textContent = '.wf-activity{display:flex;align-items:flex-start;gap:12px;padding:14px;margin:12px 0;background:#eef5f1;border:1px solid #b8cfc2;border-radius:10px;color:var(--navy);font-size:14px;line-height:1.5}.wf-spinner{display:inline-block;flex-shrink:0;width:22px;height:22px;border:3px solid #b8cfc2;border-top-color:var(--navy);border-radius:50%;animation:wf-spin .8s linear infinite}.wf-elapsed,.wf-wait-note{font-size:12px;margin-top:3px}.wf-feedback{white-space:pre-wrap;line-height:1.5;margin-top:8px}.wf-item:focus{outline:2px solid var(--navy);outline-offset:3px}.wf-diff details{margin-top:8px}.wf-diff pre{white-space:pre-wrap;font:inherit}.wf-text-draft{border-left:3px solid #9a6728;padding:12px;background:#fcf5e8;white-space:pre-wrap;margin:12px 0}.wf-no-change{padding:10px;background:#f3f5f3;border-radius:8px;line-height:1.5}@keyframes wf-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.wf-spinner{animation:none;border-style:dotted}}';
  document.head.appendChild(style);
  return {start:start, sync:sync, busy:function () { return active.size > 0; }};
})();

/* Vendora-first workspace. Decisions are acknowledged only after a committed server response. */
(function(){
  'use strict';
  var current=null, busy=false, actionMessage='';
  var labels={deal_breaker:'Hard no',red_flag:'Röd flagga',negotiate:'Förhandlingsbart',acceptable:'Acceptabelt / likvärdigt',missing:'Saknas / saknar motsvarighet'};
  var order={deal_breaker:0,red_flag:1,negotiate:2,missing:3,acceptable:4};
  async function api(url,method,body){var r=await fetch(url,{method:method||'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});var j=await r.json();if(!r.ok){var err=new Error(j.error||'Begäran misslyckades.');err.explanation=j.explanation||'';throw err;}return j;}
  function uid(){return crypto.randomUUID();}
  function reset(){current=null;window._aiMessages=[];window._aiReview=null;window._openProposals=[];window._reviewData=null;window._lastBuild=null;window._lawyerState=null;window._clauseOverrides={};}
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
    var pending=s.items.filter(i=>i.status==='pending'),companyPending=(s.companyImports||[]).some(i=>i.status==='pending'),stage=row.status==='pending_signature'?4:['vendora_signed','sent','signed'].indexOf(row.status)>=0?5:row.status==='submitted'?3:row.status==='invited'?2:1;
    var steps=['1. Jämför och anpassa','2. Kundens komplettering','3. Granska återkoppling','4. Internt godkännande','5. Underskrift'];
    var html='<div class="wf-progress">'+steps.map((x,i)=>'<span'+(stage===i+1?' aria-current="step"':'')+'>'+x+'</span>').join('')+'</div>';
    html+='<h2>Vårt avtal · version '+row.revision+'</h2><p>Godkända anpassningar ändrar endast detta avtal. Standardmallen och kundens original lämnas orörda.</p>';
    if(s.reviewRunning)html+='<div class="wf-activity" role="status"><span class="wf-spinner" aria-hidden="true"></span><div><strong>AI-granskningen pågår</strong><p>Resultatet är inte klart. Inga ändringar har godkänts ännu.</p></div></div>';
    html+='<div class="wf-actions"><button data-wf="download">Ladda ned vårt avtal</button><button data-wf="redline">Word med ändringsmarkeringar</button>';
    if(!['pending_signature','vendora_signed','sent','signed'].includes(row.status))html+='<button data-wf="invite" '+(pending.length||companyPending||s.reviewRunning?'disabled':'')+'>Skicka till kunden för granskning</button><button data-wf="signature" '+(row.signatureProblems.length||row.status==='invited'?'disabled':'')+'>Skicka för godkännande / underskrift</button>';
    if(row.status==='invited')html+='<button data-wf="withdraw">Återkalla kundlänken för omarbetning</button>';
    if(row.status==='pending_signature')html+='<button data-wf="signview">Öppna intern signering</button>';
    if(row.status==='vendora_signed'||row.status==='sent')html+='<button data-wf="signview">Visa godkänd version</button><button data-wf="counterparty">Skicka för motpartens underskrift</button><button data-wf="confirm">Registrera returnerat, underskrivet avtal</button>';
    html+='</div><div id="wf_message" role="status" aria-live="polite"></div>';
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
        if(canApply)html+='<button data-wf="accept" '+(locked?'disabled':'')+'>Godkänn '+(item.source==='customer'?'kundens förslag':'föreslagen formulering')+'</button>';
        html+='<button data-wf="keep" '+(locked?'disabled':'')+'>'+(hasChanges?'Avslå / behåll vår lydelse':'Godkänn att vår lydelse behålls')+'</button><button data-wf="rework" '+(locked?'disabled':'')+'>'+(!hasChanges?(item.proposed?'Skapa tillämpbart ändringsförslag':'Ta fram alternativ formulering'):item.issue?'Bearbeta och rätta förslaget':'Bearbeta med avtalsadvokaten')+'</button></div>';
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
        else if(action==='accept'||action==='keep')adopt(await api('/api/workflow/'+row.id+'/decisions','POST',{itemId:id,action:action,expectedRevision:current.revision,requestId:uid()}));
        else if(action==='rework'){
          var note=prompt('Vad ska advokaten tillmötesgå eller förtydliga?', 'Föreslå en konkret formulering i vårt avtal som möter motpartens behov utan att ge upp vårt grundskydd.');
          if(note&&note.trim()){
            feedback=WorkflowActivity.start('workflow:'+row.id,localHost,'Sparar underlaget för omarbetningen…');
            await window.wfEnsure(row.type);
            feedback.stage('Avtalsadvokaten tar fram ett nytt formuleringsförslag…');
            var changed=await api('/api/workflow/'+row.id+'/rework','POST',{itemId:id,instruction:note.trim(),expectedRevision:current.revision});
            newItemId=changed.reworkedItemId;
            if(current&&current.id===row.id)adopt(changed);
            feedback.finish('Nytt förslag är sparat. Granska den nya lydelsen och godkänn den separat.');feedback=null;
            var target=Array.from(el.querySelectorAll('[data-item]')).find(x=>x.dataset.item===newItemId);
            if(target){target.scrollIntoView({block:'center',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});target.focus({preventScroll:true});}
          }
        }
        else if(action==='download'||action==='redline'){var data=JSON.parse(JSON.stringify(current.data));data._trackChanges=action==='redline';await downloadAgreementData(current.type,data);}
        else if(action==='invite')await invite(row.type);
        else if(action==='signature'){await window.wfEnsure(row.type);requestCeoSignature(current.id);}
        else if(action==='signview')openSigningView(row.id);
        else if(action==='withdraw'){if(confirm('Återkalla kundlänken och öppna avtalet för omarbetning?')){await api('/api/agreements/'+row.id+'/withdraw','POST',{expectedRevision:current.revision});await refresh(row.id);}}
        else if(action==='counsel'){var approval=prompt('Vem har granskat och godkänt riskvillkoren? Ange en dokumenthänvisning.');if(approval)adopt(await api('/api/workflow/'+row.id+'/counsel-approval','POST',{note:approval,expectedRevision:current.revision}));}
        else if(action==='counterparty'){var result=await api('/api/workflow/'+row.id+'/send-signature','POST',{expectedRevision:current.revision});adopt(result);message(result.sent?'E-post skickad till motparten. Avtalet är inte markerat som underskrivet av motparten.':'E-post kunde inte skickas. Försök igen.');}
        else if(action==='confirm'){var files=await api('/api/agreements/'+row.id+'/files');if(!files.files.length)throw new Error('Ladda först upp det returnerade, underskrivna avtalet i arkivet.');var fid=prompt('Ange fil-ID för kontrollerat underskrivet avtal:\n'+files.files.map(f=>f.id+': '+f.filename).join('\n'));if(fid&&confirm('Jag har kontrollerat att båda parter undertecknat rätt, oförändrad avtalsversion.'))adopt(await api('/api/workflow/'+row.id+'/confirm-countersign','POST',{fileId:Number(fid),expectedRevision:current.revision,confirmed:true}));}
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
  async function copyView(){var m=location.hash.match(/^#agreementcopy=(\d+)\.([A-Za-z0-9_-]+)$/);if(!m)return;
    try{var v=await api('/api/public-agreements/'+m[1]+'?token='+encodeURIComponent(m[2]));var shell=document.querySelector('.shell');shell.textContent='';var card=document.createElement('section');card.className='card';
      var title=document.createElement('h2');title.textContent='Avtal för underskrift — '+(v.data.name||'')+' · version '+v.version;card.appendChild(title);
      var text=document.createElement('p');text.textContent='Ladda ned och kontrollera avtalet. Underteckna och returnera den undertecknade kopian till er kontaktperson på Vendora. Den här sidan registrerar inte en underskrift.';card.appendChild(text);
      var button=document.createElement('button');button.textContent='Ladda ned avtalet (.docx)';button.onclick=function(){downloadAgreementData(v.type,v.data);};card.appendChild(button);shell.appendChild(card);
    }catch(e){alert(e.message);}}
  window.addEventListener('hashchange',openHash);window.addEventListener('hashchange',copyView);openHash();copyView();
  var style=document.createElement('style');style.textContent='.wf-progress{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:18px}.wf-progress span{padding:8px 12px;border:1px solid var(--border);border-radius:20px;font-size:12px}.wf-progress [aria-current]{background:var(--navy);color:#fff}.wf-item{border:1px solid var(--border);border-radius:10px;padding:18px;margin-top:14px}.wf-item-title{display:flex;gap:15px;justify-content:space-between}.wf-item-title span{font-size:12px;font-weight:600}.wf-line{margin-top:10px;white-space:pre-wrap;line-height:1.5}.wf-diff{padding:12px;margin:12px 0;background:#f7f8fa;white-space:pre-wrap;line-height:1.6}.wf-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}.wf-actions button{padding:8px 13px;cursor:pointer}.wf-actions button:disabled{opacity:.45;cursor:not-allowed}.wf-note{font-size:12px;line-height:1.5;color:var(--muted);margin-top:12px}.wf-warning{color:#964514;font-size:13px;margin:12px 0}.wf-check{margin:14px 0;padding:12px;background:#f8f0df}';document.head.appendChild(style);
})();

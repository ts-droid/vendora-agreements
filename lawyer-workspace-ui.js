/* Persistent case memory + separate drafting workspace. No edits to the selected parent. */
(function () {
  'use strict';
  var view = null, epoch = 0, refs = new Set(), pending = null, legacyId = null, legacyThread = null;
  var typeNames = {da:'Leverantörs-/distributionsavtal',ra:'Återförsäljaravtal',rb:'Förenklat återförsäljaravtal',general:'Fristående affärsavtal'};
  var kindNames = {appendix:'Bilaga / appendix',addendum:'Tilläggsavtal',accession:'Anslutningsavtal',agreement:'Nytt grundavtal'};
  var $ = function (id) { return document.getElementById(id); };
  var safe = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];}); };
  async function api(url, method, body) {
    var r = await fetch(url,{method:method||'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});
    var j = await r.json();
    if(!r.ok) throw new Error(j.error || 'Arbetsytan kunde inte laddas.');
    return j;
  }
  function status(text) { if($('lwStatus')) $('lwStatus').textContent=text||''; }
  function mount() {
    if($('lwModal')) return;
    var style=document.createElement('style');
    style.textContent=`
      #lwModal{position:fixed;inset:0;z-index:10100;background:#142c25aa;display:none;align-items:center;justify-content:center;padding:14px}
      #lwModal *{box-sizing:border-box} #lwModal[hidden]{display:none}
      .lw-shell{width:min(1240px,98vw);height:92vh;background:#fffdf9;border:1px solid var(--border);border-radius:16px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px #0004}
      .lw-head{display:flex;justify-content:space-between;align-items:center;gap:12px;background:var(--navy);color:white;padding:15px 20px}.lw-head h2{font-size:19px;margin:0}.lw-head small{color:#d5e2dc}
      .lw-body{display:grid;grid-template-columns:270px minmax(0,1fr);min-height:0;flex:1}.lw-side{padding:16px;background:#f3f0e9;overflow-y:auto;border-right:1px solid var(--border)}
      .lw-side h3{font-size:14px;margin:16px 0 8px}.lw-side select{width:100%;padding:9px;border:1px solid var(--border);border-radius:6px;background:white;font:inherit;font-size:12px}
      .lw-main{min-width:0;min-height:0;display:flex;flex-direction:column}.lw-context{padding:13px 18px;border-bottom:1px solid var(--border);font-size:13px}.lw-context small{display:block;color:var(--muted);margin-top:4px}
      #lwMessages{flex:1;min-height:140px;overflow:auto;padding:16px 20px}.lw-message{max-width:95%;white-space:pre-wrap;padding:12px 14px;margin:0 0 12px;border-radius:12px;line-height:1.6;font-size:14px;background:#f2eee7;overflow-wrap:anywhere}.lw-user{margin-left:auto;background:#16362d;color:white}
      .lw-actions{display:flex;flex-wrap:wrap;gap:6px;padding:10px 18px;border-bottom:1px solid var(--border)}
      .lw-shell button{border:1px solid var(--border);border-radius:7px;padding:8px 11px;background:white;color:#16362d;cursor:pointer;font:inherit;font-size:12px}.lw-shell button:disabled{opacity:.5;cursor:wait}.lw-shell .lw-primary{background:#16362d;color:white;border-color:#16362d}.lw-head button{background:transparent;color:white;border-color:#72938a}
      .lw-compose{padding:12px 18px;border-top:1px solid var(--border);display:flex;align-items:flex-end;gap:9px}.lw-compose textarea{flex:1;min-width:0;resize:vertical;min-height:68px;max-height:220px;border:1px solid var(--border);border-radius:8px;padding:10px;font:inherit;font-size:14px}
      #lwStatus{font-size:12px;padding:0 18px 10px;color:#8a4a00;min-height:23px}.lw-muted{font-size:12px;line-height:1.5;color:var(--muted)}
      .lw-doc{padding:9px 0;border-top:1px solid #d8ddd7;font-size:12px}.lw-doc label{display:flex;align-items:flex-start;gap:8px;line-height:1.5}.lw-doc input{margin-top:3px;flex:none}.lw-doc button{margin:6px 4px 0 0;padding:5px 8px}.lw-preview{background:#fff;border:1px solid var(--border);border-radius:10px;margin:12px 0;padding:14px}.lw-preview p{font-size:13px;line-height:1.6;white-space:pre-wrap}.lw-preview h3{font-size:16px}.lw-preview h4{font-size:14px;margin:16px 0 7px}.lw-preview summary{cursor:pointer;font-weight:bold;overflow-wrap:anywhere}
      .lw-warning{color:#8a4a00;background:#fff5db;padding:10px;border-radius:6px}.lw-source{font-size:12px;color:#58615b;margin:8px 0}.lw-start{padding:24px;max-width:560px}.lw-start select{padding:9px;width:100%;margin:10px 0 16px}
      @media(max-width:760px){#lwModal{padding:0}.lw-shell{height:100dvh;width:100%;border-radius:0}.lw-body{grid-template-columns:1fr;overflow:auto}.lw-side{max-height:220px;border-bottom:1px solid var(--border);border-right:0}.lw-main{min-height:65vh}.lw-head small{display:none}}
    `;
    document.head.appendChild(style);
    var el=document.createElement('div');el.id='lwModal';el.setAttribute('role','dialog');el.setAttribute('aria-modal','true');el.setAttribute('aria-labelledby','lwTitle');
    el.innerHTML='<div class="lw-shell"><header class="lw-head"><div><h2 id="lwTitle">Avtalsadvokaten</h2><small>Sparad chatt · Fristående utkast · Huvudavtalet förblir oförändrat</small></div><button id="lwClose" type="button">Stäng ×</button></header>'
      +'<div class="lw-body"><aside class="lw-side"><h3>10 senast skapade avtal</h3><select id="lwRecent" aria-label="Välj huvudavtal"><option value="">Välj avtal…</option></select>'
      +'<p class="lw-muted">Endast valt avtal och markerade dokument används som underlag. Äldre avtal öppnas från arkivet.</p><button id="lwStandalone" type="button">Nytt fristående avtal</button>'
      +'<h3>Sparade chattar</h3><select id="lwThreads" aria-label="Återuppta sparad chatt"><option value="">Välj chatt…</option></select>'
      +'<button id="lwNewThread" type="button">Ny chatt om valt avtal</button><button id="lwImport" type="button" hidden>Spara den synliga gamla chatten</button>'
      +'<h3>Bilagor & tillägg</h3><p class="lw-muted">Markera dokument som advokaten ska läsa och kunna hänvisa till i nästa fråga.</p><div id="lwDocuments"></div></aside>'
      +'<section class="lw-main"><div id="lwContext" class="lw-context"></div><div id="lwActions" class="lw-actions"></div><div id="lwMessages" aria-live="polite"></div>'
      +'<div class="lw-compose"><textarea id="lwInput" rows="3" aria-label="Meddelande till avtalsadvokaten" placeholder="Beskriv vad bilagan eller tilläggsavtalet ska reglera…"></textarea><button id="lwSend" type="button" class="lw-primary">Skicka</button></div><div id="lwStatus" role="status"></div></section></div></div>';
    document.body.appendChild(el);
    $('lwClose').onclick=function(){el.style.display='none';epoch++;};
    $('lwRecent').onchange=function(){if(this.value) openLawyerWorkspace(Number(this.value));};
    $('lwThreads').onchange=function(){if(this.value) openThread(this.value);};
    $('lwStandalone').onclick=showStandalone;
    $('lwNewThread').onclick=async function(){if(!view)return;try{render(await api('/api/lawyer/threads','POST',{agreementId:view.thread.agreementId,agreementType:view.thread.type,newThread:true}));await recent();}catch(e){status(e.message);}};
    $('lwImport').onclick=async function(){
      if(!view || !window._aiMessages || !window._aiMessages.length)return;
      if(!confirm('Spara den synliga chatten som en NY chatt om '+view.thread.title+'? Kontrollera att meddelandena avser just detta avtal.'))return;
      try{render(await api('/api/lawyer/threads','POST',{agreementId:view.thread.agreementId,agreementType:view.thread.type,newThread:true,importMessages:window._aiMessages.map(function(m){return {role:m.role,content:m.content};})}));await recent();}catch(e){status(e.message);}
    };
    $('lwSend').onclick=send;
    $('lwInput').onkeydown=function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();}};
    // Keep keyboard focus inside the dialog while it is open.
    el.onkeydown=function(e){
      if(e.key==='Escape'){ $('lwClose').click(); return; }
      if(e.key!=='Tab')return;
      var focus=Array.from(el.querySelectorAll('button,select,textarea,input,a[href],summary')).filter(function(x){return !x.disabled && x.getClientRects().length;});
      if(!focus.length)return;
      if(e.shiftKey&&document.activeElement===focus[0]){e.preventDefault();focus[focus.length-1].focus();}
      else if(!e.shiftKey&&document.activeElement===focus[focus.length-1]){e.preventDefault();focus[0].focus();}
    };
  }
  async function recent() {
    var data=await api('/api/lawyer/recent');
    $('lwRecent').innerHTML='<option value="">Välj avtal…</option>'+data.agreements.map(function(a){return '<option value="'+a.id+'">#'+a.id+' · '+safe(a.counterparty_name||'Avtal')+' · '+safe(typeNames[a.type])+'</option>';}).join('');
    $('lwThreads').innerHTML='<option value="">Välj chatt…</option>'+data.threads.map(function(t){return '<option value="'+safe(t.id)+'">'+safe(t.title)+' · '+safe(String(t.updated_at).slice(0,10))+'</option>';}).join('');
    if(view){$('lwRecent').value=String(view.thread.agreementId||'');$('lwThreads').value=view.thread.id;}
  }
  function showStandalone() {
    view=null;refs.clear();epoch++;$('lwContext').textContent='Fristående arbetsläge – inget huvudavtal ändras.';$('lwActions').innerHTML='';$('lwDocuments').innerHTML='';
    $('lwMessages').innerHTML='<div class="lw-start"><h3>Nytt grundavtal</h3><p>Välj affärsrelation en gång. Advokaten kan därefter skriva och bearbeta ett separat avtalsutkast.</p>'
      +'<label for="lwNewType">Affärsrelation</label><select id="lwNewType"><option value="general">Annat affärsavtal – ange förutsättningar i chatten</option><option value="ra">Återförsäljare – Vendora säljer</option><option value="rb">Förenklat återförsäljaravtal</option>'+(window._isAdmin?'<option value="da">Leverantör – Vendora köper</option>':'')+'</select><button id="lwStart" class="lw-primary">Starta sparad chatt</button></div>';
    $('lwSend').disabled=true;$('lwNewThread').disabled=true;
    $('lwStart').onclick=async function(){try{render(await api('/api/lawyer/threads','POST',{agreementType:$('lwNewType').value,newThread:true}));await recent();$('lwInput').focus();}catch(e){status(e.message);}};
  }
  window.openLawyerWorkspace=async function(id) {
    mount();var generation=++epoch;$('lwModal').style.display='flex';$('aiDrawer').style.display='none';status('Hämtar sparat avtalsunderlag…');
    try{
      if(id){var data=await api('/api/lawyer/threads','POST',{agreementId:Number(id)});if(generation!==epoch)return;render(data);}
      else showStandalone();
      await recent();status('');$('lwInput').focus();
    }catch(e){status(e.message);}
  };
  async function openThread(id) {
    var generation=++epoch;status('Hämtar sparad chatt…');
    try{var data=await api('/api/lawyer/threads/'+encodeURIComponent(id));if(generation!==epoch)return;render(data);await recent();status('');}catch(e){status(e.message);}
  }
  function render(data) {
    if(!view||view.thread.id!==data.thread.id)refs.clear();
    view=data;window._lawyerWorkspaceView=data;var t=data.thread, s=t.source;
    $('lwContext').innerHTML='<strong>'+safe(t.title)+'</strong> · '+safe(typeNames[t.type])
      + (s?'<small>Huvudavtal #'+s.id+' · källrevision '+s.revision+' · '+safe(s.agreementDate||'avtalsdatum saknas')+' · '+safe(s.status)+'</small><small>Underlag: sparad avtalsdata. Kontrollera mot den signerade originalfilen vid juridiskt bindande tillägg.</small>':'<small>Fristående utkast – ingen standardmall eller annat avtal skrivs över.</small>')
      +(t.sourceStale?'<div class="lw-warning">Huvudavtalet har ändrats. Historiken är bevarad; starta en ny chatt för aktuell version.</div>':'');
    $('lwActions').innerHTML=Object.keys(kindNames).filter(function(k){return !!s || k==='agreement';}).map(function(k){return '<button data-kind="'+k+'">'+safe(kindNames[k])+'</button>';}).join('');
    $('lwActions').querySelectorAll('button').forEach(function(b){b.onclick=function(){
      $('lwInput').value='Skriv '+(b.dataset.kind==='agreement'?'ett nytt grundavtal':'ett separat '+kindNames[b.dataset.kind].toLowerCase()+' till valt huvudavtal')+'. Syftet är: ';
      $('lwInput').focus();
    };});
    var html=t.messages.length?'':'<p class="lw-muted">Chatten sparas på detta ärende. Beskriv vad det nya dokumentet ska innehålla. Ingenting läggs in i huvudavtalet eller skickas till motparten automatiskt.</p>';
    t.messages.forEach(function(m){
      html+='<div class="lw-message '+(m.role==='user'?'lw-user':'')+'">'+safe(m.content)+'</div>';
      (m.documentIds||[]).forEach(function(id){var d=data.documents.find(function(x){return x.id===id;});if(d) html+=draftPreview(d);});
      if(m.proposals&&m.proposals.length) html+='<p class="lw-muted">'+m.proposals.length+' förslag gäller huvudavtalets lydelse. De är inte införda. Granska dem i avtalets ordinarie ändringsvy.</p>';
    });
    $('lwMessages').innerHTML=html;$('lwMessages').scrollTop=$('lwMessages').scrollHeight;
    $('lwDocuments').innerHTML=data.documents.length?data.documents.map(function(d){
      return '<div class="lw-doc"><label><input type="checkbox" data-ref="'+d.id+'" '+(refs.has(d.id)?'checked':'')+' '+(d.review_status==='discarded'?'disabled':'')+'><span><strong>'+safe(d.content.title)+'</strong><br>'+safe(d.document_number)+' · v'+d.version+' · '+safe(d.review_status==='reviewed'?'Internt granskat, ej signerat':d.review_status==='discarded'?'Avvisat':'Utkast')+'</span></label>'
        +'<button data-export="'+d.id+'">Word</button><button data-preview="'+d.id+'">Visa</button><button data-rework="'+d.id+'">Bearbeta</button>'
        +(d.review_status==='draft'?'<button data-review="'+d.id+'">Markera granskat</button><button data-discard="'+d.id+'">Avvisa</button>':'')+'</div>';
    }).join(''):'<p class="lw-muted">Inga separata utkast ännu.</p>';
    $('lwDocuments').querySelectorAll('[data-ref]').forEach(function(box){box.onchange=function(){if(box.checked)refs.add(box.dataset.ref);else refs.delete(box.dataset.ref);};});
    $('lwDocuments').querySelectorAll('[data-export]').forEach(function(b){b.onclick=function(){download(b.dataset.export);};});
    $('lwDocuments').querySelectorAll('[data-preview]').forEach(function(b){b.onclick=function(){var d=data.documents.find(function(x){return x.id===b.dataset.preview;});$('lwMessages').insertAdjacentHTML('beforeend',draftPreview(d));$('lwMessages').scrollTop=$('lwMessages').scrollHeight;};});
    $('lwDocuments').querySelectorAll('[data-rework]').forEach(function(b){b.onclick=function(){var d=data.documents.find(function(x){return x.id===b.dataset.rework;});refs.add(d.id);render(view);$('lwInput').value='Bearbeta dokument '+d.document_number+' v'+d.version+' (ID '+d.id+'). Skapa en ny version och behåll övrig text. Ändra följande: ';$('lwInput').focus();};});
    $('lwDocuments').querySelectorAll('[data-review],[data-discard]').forEach(function(b){b.onclick=async function(){
      var id=b.dataset.review||b.dataset.discard, d=data.documents.find(function(x){return x.id===id;});
      if(!confirm(b.dataset.review?'Markera denna version som internt granskad? Detta är inte en underskrift eller ett godkännande från motparten.':'Avvisa detta utkast? Text och historik bevaras.'))return;
      try{render(await api('/api/lawyer/documents/'+id+'/review','POST',{status:b.dataset.review?'reviewed':'discarded',expectedDigest:d.content_digest}));status('Beslutet är sparat. Huvudavtalet är oförändrat.');}catch(e){status(e.message);}
    };});
    $('lwSend').disabled=t.sourceStale||t.busy||!data.aiEnabled;
    $('lwNewThread').disabled=false;
    $('lwImport').hidden=!(window._aiMessages&&window._aiMessages.length && !legacyThread);
    $('lwRecent').value=String(t.agreementId||'');$('lwThreads').value=t.id;
  }
  function draftPreview(d) {
    var c=d.content,s=d.source;
    return '<details class="lw-preview" open><summary>'+safe(c.title)+' · '+safe(d.document_number)+' v'+d.version+'</summary>'
      +'<div class="lw-source">Separat utkast – ej undertecknat. '+(s?'Hänvisar till huvudavtal #'+s.id+' med '+safe(s.name)+' · källrevision '+s.revision:'Fristående avtal')+'</div>'
      +(c.missing_information.length?'<div class="lw-warning">Uppgifter att komplettera: '+safe(c.missing_information.join('; '))+'</div>':'')
      +(d.references_data||[]).map(function(r){return '<p class="lw-source">Referens: '+safe(r.number)+' v'+r.version+' — '+safe(r.title)+' (utkast, ej avtalat)</p>';}).join('')
      +c.sections.map(function(section){return '<h4>'+safe(section.heading)+'</h4>'+section.paragraphs.map(function(p){return '<p>'+safe(p)+'</p>';}).join('');}).join('')+'</details>';
  }
  async function send() {
    if(!view||$('lwSend').disabled)return;
    var text=$('lwInput').value.trim();if(!text)return;
    var t=view.thread,generation=epoch;
    if(!pending||pending.thread!==t.id||pending.text!==text) pending={thread:t.id,text:text,id:crypto.randomUUID()};
    var body={message:text,expectedRevision:t.revision,requestId:pending.id,referenceIds:Array.from(refs)};
    $('lwSend').disabled=true;status('Advokaten arbetar. Fråga, svar och dokument sparas tillsammans…');
    try{
      var data=await api('/api/lawyer/threads/'+t.id+'/messages','POST',body);
      if(generation!==epoch)return;
      var last=data.thread.messages[data.thread.messages.length-1];(last.documentIds||[]).forEach(function(id){refs.add(id);});
      pending=null;render(data);$('lwInput').value='';status('Sparat. Huvudavtalet är oförändrat.');await recent();
    }catch(e){if(generation===epoch)status(e.message);}
    finally{if(generation===epoch&&view)$('lwSend').disabled=view.thread.sourceStale||!view.aiEnabled;}
  }
  window.buildLawyerDraftDocx=async function(d) {
    var h=docxHelpers(),c=d.content,sv=c.language==='sv',children=[];
    children.push(h.h1(c.title),h.note(sv?'UTKAST — EJ UNDERTECKNAT':'DRAFT — NOT SIGNED'));
    children.push(h.par((sv?'Dokumentreferens: ':'Document reference: ')+d.document_number+' · v'+d.version));
    if(d.source){var s=d.source;children.push(h.par((sv?'Huvudavtal: ':'Master agreement: ')+((sv?typeNames:{ra:'Reseller Agreement',rb:'Reseller Agreement — Simplified',da:'Distributor Agreement'})[s.type]||s.type)+' — Vendora Nordic AB / '+s.name+' — '+(s.agreementDate||(sv?'[avtalsdatum saknas]':'[agreement date missing]'))+' — #'+s.id+' / revision '+s.revision));}
    if(c.effective_date)children.push(h.par((sv?'Ikraftträdande: ':'Effective date: ')+c.effective_date));
    (d.references_data||[]).forEach(function(r){children.push(h.par((sv?'Hänvisning till separat dokument: ':'Reference to separate document: ')+r.number+' v'+r.version+' — '+r.title+(sv?' (utkast; inte i sig avtalat)':' (draft; not itself agreed)')));});
    if(c.missing_information.length)children.push(h.note((sv?'Att komplettera: ':'To be completed: ')+c.missing_information.join('; ')));
    c.sections.forEach(function(s){children.push(h.h2(s.heading));s.paragraphs.forEach(function(p){children.push(h.par(p));});});
    var blob=await window.docx.Packer.toBlob(h.makeDoc(children));
    var filename=(d.document_number+'_v'+d.version+'_'+c.title).replace(/[^a-zA-Z0-9åäöÅÄÖ._-]+/g,'_').slice(0,150)+'.docx';
    return {blob:blob,filename:filename};
  };
  async function download(id) {
    try{
      var response=await api('/api/lawyer/documents/'+id);
      if(response.sourceStale&&!confirm('Huvudavtalet har ändrats sedan utkastet skapades. Ladda ned den historiska utkastversionen ändå?'))return;
      var out=await buildLawyerDraftDocx(response.document);saveAs(out.blob,out.filename);status('Utkastet har exporterats. Ingen underskrift eller kundleverans har gjorts.');
    }catch(e){status(e.message);}
  }
  // Existing drawer shares the same server-side memory for a saved agreement.
  window.lwResetLegacyChat=function(id){if(legacyId!==id){legacyId=id;legacyThread=null;window._aiMessages=[];window._openProposals=[];renderAiMessages();}};
  window.lwRestoreLegacyChat=async function(){
    var e=window._editing;if(!e||window._aiReview||window._signData)return;
    lwResetLegacyChat(e.id);
    try{var data=await api('/api/lawyer/threads','POST',{agreementId:e.id});if(!window._editing||window._editing.id!==e.id)return;
      legacyThread=data.thread;window._aiMessages=data.thread.messages;renderAiMessages();$('aiMemoryStatus').textContent=data.thread.sourceStale?'Ny källversion – öppna arbetsytan':'Sparad chatt för #'+e.id;
    }catch(err){if($('aiMemoryStatus'))$('aiMemoryStatus').textContent=err.message;}
  };
  window.lwSendLegacyChat=async function(text){
    var e=window._editing;if(!e)return;var id=e.id;$('aiSend').disabled=true;
    try{
      var data=await api('/api/lawyer/threads','POST',{agreementId:id});
      var result=await api('/api/lawyer/threads/'+data.thread.id+'/messages','POST',{message:text,expectedRevision:data.thread.revision,requestId:crypto.randomUUID(),referenceIds:[]});
      if(!window._editing||window._editing.id!==id)return;
      legacyThread=result.thread;window._aiMessages=result.thread.messages;$('aiInput').value='';renderAiMessages();
      var last=result.thread.messages[result.thread.messages.length-1];if(last.proposals&&last.proposals.length)renderProposals(last.proposals);
      $('aiMemoryStatus').textContent='Sparat för #'+id+(last.documentIds&&last.documentIds.length?' · nytt dokument finns i arbetsytan':'');
    }catch(err){$('aiMemoryStatus').textContent=err.message;}
    finally{$('aiSend').disabled=false;}
  };
})();

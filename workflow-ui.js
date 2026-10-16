/* Vendora-first workspace. Decisions are acknowledged only after a committed server response. */
(function(){
  'use strict';
  var current=null, busy=false;
  var labels={deal_breaker:'Hard no',red_flag:'Röd flagga',negotiate:'Förhandlingsbart',acceptable:'Acceptabelt / likvärdigt',missing:'Saknas / saknar motsvarighet'};
  var order={deal_breaker:0,red_flag:1,negotiate:2,missing:3,acceptable:4};
  async function api(url,method,body){var r=await fetch(url,{method:method||'GET',headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});var j=await r.json();if(!r.ok)throw new Error(j.error||'Begäran misslyckades.');return j;}
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
  function render(){if(!current||!current.state)return;var row=current,el=mount(row.type),s=row.state;if(!el)return;
    var pending=s.items.filter(i=>i.status==='pending'),stage=row.status==='pending_signature'?4:['vendora_signed','sent','signed'].indexOf(row.status)>=0?5:row.status==='submitted'?3:row.status==='invited'?2:1;
    var steps=['1. Jämför och anpassa','2. Kundens komplettering','3. Granska återkoppling','4. Internt godkännande','5. Underskrift'];
    var html='<div class="wf-progress">'+steps.map((x,i)=>'<span'+(stage===i+1?' aria-current="step"':'')+'>'+x+'</span>').join('')+'</div>';
    html+='<h2>Vårt avtal · version '+row.revision+'</h2><p>Godkända anpassningar ändrar endast detta avtal. Standardmallen och kundens original lämnas orörda.</p>';
    if(s.reviewRunning)html+='<p role="status">Jämförelsen pågår. Inga ändringar har godkänts ännu.</p>';
    html+='<div class="wf-actions"><button data-wf="download">Ladda ned vårt avtal</button><button data-wf="redline">Word med ändringsmarkeringar</button>';
    if(!['pending_signature','vendora_signed','sent','signed'].includes(row.status))html+='<button data-wf="invite" '+(pending.length?'disabled':'')+'>Skicka till kunden för granskning</button><button data-wf="signature" '+(row.signatureProblems.length||row.status==='invited'?'disabled':'')+'>Skicka för godkännande / underskrift</button>';
    if(row.status==='invited')html+='<button data-wf="withdraw">Återkalla kundlänken för omarbetning</button>';
    if(row.status==='pending_signature')html+='<button data-wf="signview">Öppna intern signering</button>';
    if(row.status==='vendora_signed'||row.status==='sent')html+='<button data-wf="signview">Visa godkänd version</button><button data-wf="counterparty">Skicka för motpartens underskrift</button><button data-wf="confirm">Registrera returnerat, underskrivet avtal</button>';
    html+='</div><div id="wf_message" role="status" aria-live="polite"></div>';
    if(row.signatureProblems.length)html+='<details class="wf-check"><summary>Kvar före slutgodkännande ('+row.signatureProblems.length+')</summary><p>'+row.signatureProblems.map(esc).join('<br>')+'</p>'+(window._isAdmin?'<button data-wf="counsel">Dokumentera särskilt godkännande</button>':'')+'</details>';
    if(s.sent)html+='<p class="wf-note">Senast utskickad version: '+s.sent.version+' · E-post: '+esc(s.sent.delivery==='sent'?'skickad':s.sent.delivery==='failed'?'kunde inte skickas':'inte bekräftad')+'. Kundens villkorsförslag ändrar inte avtalet automatiskt.</p>';
    html+='<h3>'+pending.length+' förslag väntar på beslut</h3>';
    s.items.slice().sort((a,b)=>(a.status==='pending'?0:1)-(b.status==='pending'?0:1)||(order[a.classification]||0)-(order[b.classification]||0)).forEach(function(item){
      html+='<article class="wf-item" data-item="'+esc(item.id)+'"><div class="wf-item-title"><strong>'+esc(item.topic)+'</strong><span>'+esc(labels[item.classification]||'Förslag')+'</span></div>';
      html+=line('Kundens villkor:',item.their)+line('Vår position:',item.our)+line('Advokatens bedömning:',item.rationale);
      if(item.source==='customer')html+='<p class="wf-note">Kundens eget förslag. Ingen automatisk AI-rekommendation. Bearbeta med advokaten för ett alternativ.</p>';
      if(item.preview&&item.preview.length)html+='<div class="wf-diff">'+item.preview.map(p=>'<div><strong>'+esc(p.label||p.target.id)+'</strong><div>'+redlineHtml(p.oldText,p.newText)+'</div></div>').join('')+'</div>';
      if(item.requiresCounsel)html+='<p class="wf-warning">Det föreslagna alternativet kräver särskilt godkännande före underskrift.</p>';
      if(item.issue&&item.status==='pending')html+='<p class="wf-warning">'+esc(item.issue)+'</p>';
      if(item.status==='pending')html+='<div class="wf-actions"><button data-wf="accept" '+(!item.changes.length||item.issue?'disabled':'')+'>Godkänn '+(item.source==='customer'?'kundens förslag':'föreslagen formulering')+'</button><button data-wf="keep">Avslå / behåll vår lydelse</button><button data-wf="rework">Bearbeta med avtalsadvokaten</button></div>';
      else html+='<p class="wf-note">'+esc(item.status==='accepted'?'Godkänt och sparat':item.status==='kept'?'Vår lydelse behålls':'Ersatt av ett nytt förslag')+(item.decidedBy?' · '+esc(item.decidedBy):'')+'</p>';
      html+='</article>';
    });
    el.innerHTML=html;
    el.querySelectorAll('[data-wf]').forEach(function(btn){btn.onclick=async function(){if(busy)return;busy=true;btn.disabled=true;var action=btn.dataset.wf,article=btn.closest('[data-item]'),id=article&&article.dataset.item;
      try{
        if(action==='accept'||action==='keep')adopt(await api('/api/workflow/'+row.id+'/decisions','POST',{itemId:id,action:action,expectedRevision:current.revision,requestId:uid()}));
        else if(action==='rework'){var note=prompt('Vad ska advokaten tillmötesgå eller förtydliga?');if(note){message('Advokaten bearbetar förslaget. Inget godkänns automatiskt.');adopt(await api('/api/workflow/'+row.id+'/rework','POST',{itemId:id,instruction:note,expectedRevision:current.revision}));}}
        else if(action==='download'||action==='redline'){var data=JSON.parse(JSON.stringify(current.data));data._trackChanges=action==='redline';await downloadAgreementData(current.type,data);}
        else if(action==='invite')await invite(row.type);
        else if(action==='signature'){await window.wfEnsure(row.type);requestCeoSignature(current.id);}
        else if(action==='signview')openSigningView(row.id);
        else if(action==='withdraw'){if(confirm('Återkalla kundlänken och öppna avtalet för omarbetning?')){await api('/api/agreements/'+row.id+'/withdraw','POST',{expectedRevision:current.revision});await refresh(row.id);}}
        else if(action==='counsel'){var approval=prompt('Vem har granskat och godkänt riskvillkoren? Ange en dokumenthänvisning.');if(approval)adopt(await api('/api/workflow/'+row.id+'/counsel-approval','POST',{note:approval,expectedRevision:current.revision}));}
        else if(action==='counterparty'){var result=await api('/api/workflow/'+row.id+'/send-signature','POST',{expectedRevision:current.revision});adopt(result);message(result.sent?'E-post skickad till motparten. Avtalet är inte markerat som underskrivet av motparten.':'E-post kunde inte skickas. Försök igen.');}
        else if(action==='confirm'){var files=await api('/api/agreements/'+row.id+'/files');if(!files.files.length)throw new Error('Ladda först upp det returnerade, underskrivna avtalet i arkivet.');var fid=prompt('Ange fil-ID för kontrollerat underskrivet avtal:\n'+files.files.map(f=>f.id+': '+f.filename).join('\n'));if(fid&&confirm('Jag har kontrollerat att båda parter undertecknat rätt, oförändrad avtalsversion.'))adopt(await api('/api/workflow/'+row.id+'/confirm-countersign','POST',{fileId:Number(fid),expectedRevision:current.revision,confirmed:true}));}
      }catch(e){try{await refresh(row.id);}catch(_){}message(e.message,true);}finally{busy=false;btn.disabled=false;}};});
  }
  function message(text,bad){var el=document.getElementById('wf_message');if(el){el.textContent=text;el.className=bad?'wf-warning':'wf-note';}else alert(text);}
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

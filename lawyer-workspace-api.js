'use strict';
const crypto = require('crypto');
const C = require('./lawyer-workspace-core');

function install(app, deps) {
  const {db, auth, ai, isAdmin, isLocked, loadPlaybook, ownedReview, limiter} = deps;
  const canOwn = (req, row) => row && (isAdmin(req.user) || Number(row.created_by) === Number(req.user.uid));
  const wrap = fn => async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      if (!db.enabled) throw C.error('Sparat minne kräver att avtalsarkivet är aktiverat.', 503);
      await fn(req, res);
    } catch (e) {
      if (!e.status) console.error('[lawyer-workspace]', e.message);
      res.status(e.status || 500).json({error: e.status ? e.message : 'Arbetsytan kunde inte uppdateras. Försök igen.'});
    }
  };
  async function parent(req, id, client = db) {
    if (!Number.isSafeInteger(Number(id)) || Number(id) < 1) throw C.error('Avtalet finns inte.', 404);
    const row = (await client.query('SELECT * FROM agreements WHERE id=$1', [id])).rows[0];
    if (!canOwn(req, row) || (row.type === 'da' && !isAdmin(req.user))) throw C.error('Avtalet finns inte.', 404);
    return row;
  }
  async function thread(req, id, client = db, lock = false) {
    const row = (await client.query('SELECT * FROM lawyer_threads WHERE id=$1' + (lock ? ' FOR UPDATE' : ''), [id])).rows[0];
    if (!canOwn(req, row)) throw C.error('Chatten finns inte.', 404);
    const original = row.agreement_id ? await parent(req, row.agreement_id, client) : null;
    return {row, original};
  }
  async function docsFor(req, t, client = db) {
    return (await client.query(`SELECT * FROM lawyer_documents WHERE
      (thread_id=$1 OR (agreement_id=$2 AND $2 IS NOT NULL)) AND ($3 OR created_by=$4)
      ORDER BY created_at DESC, id DESC LIMIT 60`, [t.id, t.agreement_id, isAdmin(req.user), req.user.uid])).rows;
  }
  async function view(req, id) {
    const {row, original} = await thread(req, id);
    const documents = await docsFor(req, row);
    return {thread: {id: row.id, title: row.title, agreementId: row.agreement_id, type: row.agreement_type,
      source: row.source, revision: row.revision, messages: row.messages, busy: !!row.pending_token && Date.now() - new Date(row.pending_since) < 10*60*1000,
      sourceStale: C.stale(row, original), createdAt: row.created_at}, documents,
      allowOriginalChanges: !!original && !isLocked(original) && original.status !== 'signed', aiEnabled: ai.enabled};
  }
  app.get('/api/lawyer/recent', auth.requireAuth, wrap(async (req, res) => {
    const agreements = (await db.query(`SELECT id,type,counterparty_name,status,created_at FROM agreements
      WHERE ($1 OR created_by=$2) AND ($1 OR type<>'da') ORDER BY created_at DESC,id DESC LIMIT 10`, [isAdmin(req.user),req.user.uid])).rows;
    const threads = (await db.query(`SELECT t.id,t.title,t.agreement_id,t.agreement_type,t.updated_at FROM lawyer_threads t
      LEFT JOIN agreements a ON a.id=t.agreement_id WHERE t.created_by=$1
      AND (t.agreement_id IS NULL OR (($2 OR a.created_by=$1) AND ($2 OR a.type<>'da')))
      ORDER BY t.updated_at DESC LIMIT 20`, [req.user.uid, isAdmin(req.user)])).rows;
    res.json({agreements, threads});
  }));
  app.post('/api/lawyer/threads', auth.requireAuth, wrap(async (req, res) => {
    const input = req.body || {};
    const original = input.agreementId ? await parent(req, input.agreementId) : null;
    const type = original ? original.type : input.agreementType;
    if (!C.TYPES.includes(type) || (type === 'da' && !isAdmin(req.user))) throw C.error('Välj en tillåten avtalstyp.');
    const messages = C.importedMessages(input.importMessages);
    const id = await db.withTransaction(async client => {
      // Concurrent opens of the same agreement/user must resume ONE thread.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['lawyer:' + req.user.uid + ':' + (original ? original.id : type)]);
      if (!input.newThread && !messages.length && original) {
        const existing = (await client.query('SELECT id FROM lawyer_threads WHERE agreement_id=$1 AND created_by=$2 ORDER BY created_at DESC LIMIT 1', [original.id,req.user.uid])).rows[0];
        if (existing) return existing.id;
      }
      const key = crypto.randomUUID();
      await client.query(`INSERT INTO lawyer_threads(id,agreement_id,created_by,agreement_type,title,source,messages)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [key, original ? original.id : null, req.user.uid, type,
        original ? (original.counterparty_name || 'Avtal') + ' — #' + original.id : 'Fristående avtalsutkast', C.sourceOf(original), JSON.stringify(messages)]);
      return key;
    });
    res.json(await view(req,id));
  }));
  app.get('/api/lawyer/threads/:id', auth.requireAuth, wrap(async (req,res) => res.json(await view(req, req.params.id))));
  app.delete('/api/lawyer/threads/:id', auth.requireAuth, wrap(async (req,res) => {
    await db.withTransaction(async client => {
      const {row} = await thread(req,req.params.id,client,true);
      if (row.pending_token && Date.now()-new Date(row.pending_since)<10*60*1000) throw C.error('Invänta AI-svaret innan chatten raderas.',409);
      const count = await client.query('SELECT count(*)::int n FROM lawyer_documents WHERE thread_id=$1',[row.id]);
      if (count.rows[0].n) throw C.error('Chatten har dokument och bevaras för spårbarhet. Starta en ny chatt i stället.',409);
      await client.query('DELETE FROM lawyer_threads WHERE id=$1',[row.id]);
    });
    res.json({deleted:true});
  }));
  app.post('/api/lawyer/threads/:id/messages', auth.requireAuth, limiter, wrap(async (req,res) => {
    if (!ai.enabled) throw C.error('AI är inte aktiverad på servern.',503);
    const body = req.body || {}, text = C.validateMessage(body.message);
    if (typeof body.requestId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(body.requestId)) throw C.error('Ogiltigt meddelande-ID.');
    const lease = crypto.randomUUID();
    const start = await db.withTransaction(async client => {
      const {row,original} = await thread(req,req.params.id,client,true);
      const prior = row.messages.find(m => m.requestId === body.requestId && m.role === 'user');
      if (prior) {
        if (prior.content !== text) throw C.error('Meddelande-ID:t har redan använts för en annan fråga.',409);
        return {replay:true};
      }
      C.checkRevision(row,body.expectedRevision);
      if (C.stale(row,original)) throw C.error('Huvudavtalet har ändrats sedan denna chatt skapades. Starta en ny chatt med den senaste versionen; den gamla historiken finns kvar.',409);
      if (row.pending_token && Date.now()-new Date(row.pending_since)<10*60*1000) throw C.error('En fråga behandlas redan. Invänta svaret.',409);
      C.checkHistory(row.messages,text);
      const available = await docsFor(req,row,client);
      const selected = body.referenceIds || [];
      if (!Array.isArray(selected) || selected.length > 12 || new Set(selected).size !== selected.length) throw C.error('Välj högst tolv dokumentreferenser.');
      const documents = selected.map(id => {
        const d = available.find(x => x.id===id && x.review_status!=='discarded');
        if (!d) throw C.error('En vald dokumentreferens finns inte i detta ärende.',404);
        return d;
      });
      if (JSON.stringify(documents).length>220000) throw C.error('De valda dokumenten är för omfattande. Välj färre referenser.');
      await client.query('UPDATE lawyer_threads SET pending_token=$1,pending_since=now() WHERE id=$2',[lease,row.id]);
      return {row,original,documents};
    });
    if (start.replay) { res.json(await view(req,req.params.id)); return; }
    try {
      const {row,original,documents} = start;
      let review = null;
      if (body.reviewId) {
        review = await ownedReview(req,body.reviewId);
        // A review must explicitly belong to THIS parent. Matching family alone is insufficient.
        const link = (await db.query('SELECT agreement_id FROM contract_reviews WHERE id=$1',[body.reviewId])).rows[0];
        if (!review || !link || link.agreement_id!==row.agreement_id) throw C.error('Granskningen tillhör inte det valda avtalet.',400);
      }
      const context = {source:row.source, documents, allowOriginalChanges:!!original && !isLocked(original) && original.status!=='signed'};
      const out = await ai.chat(row.source ? row.source.data : {_type:row.agreement_type},
        row.messages.concat({role:'user',content:text}), {agreementType:row.agreement_type,playbook:await loadPlaybook(),review,workspace:context});
      if (!out || typeof out.reply!=='string' || out.reply.length>80000) throw C.error('AI-svaret kunde inte sparas.',502);
      const drafts = (out.documents || []);
      if (!Array.isArray(drafts) || drafts.length>4) throw C.error('AI-svaret innehåller för många dokument.',502);
      const checked = drafts.map(d=>C.validateDraft(d,row.source,documents));
      await db.withTransaction(async client => {
        const current = await thread(req,row.id,client,true);
        if (current.row.pending_token!==lease || current.row.revision!==row.revision) throw C.error('Chatten ändrades under arbetet. Ladda om innan du försöker igen.',409);
        if (C.stale(row,current.original)) throw C.error('Huvudavtalet ändrades under arbetet; svaret har inte införts.',409);
        const savedIds=[];
        for (const d of checked) {
          if (d.previous) {
            const later = await client.query('SELECT id FROM lawyer_documents WHERE replaces_id=$1',[d.previous.id]);
            if (later.rows.length) throw C.error('Utkastet har redan en nyare version. Välj den versionen och försök igen.',409);
          }
          const id=crypto.randomUUID(), number=d.previous ? d.previous.document_number : 'VD-'+crypto.randomUUID().slice(0,8).toUpperCase();
          await client.query(`INSERT INTO lawyer_documents(id,thread_id,agreement_id,created_by,document_number,version,replaces_id,source,content,references_data,content_digest)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[id,row.id,row.agreement_id,req.user.uid,number,d.previous ? d.previous.version+1 : 1,
            d.previous ? d.previous.id : null,row.source,d.content,JSON.stringify(d.references),C.digest(d.content)]);
          savedIds.push(id);
        }
        const at = new Date().toISOString();
        const messages = row.messages.concat({role:'user',content:text,requestId:body.requestId,at},
          {role:'assistant',content:out.reply,requestId:body.requestId,at,documentIds:savedIds,
            proposals:context.allowOriginalChanges && Array.isArray(out.proposals) ? out.proposals : []});
        // Never silently discard early conversation memory to fit a model limit.
        await client.query('UPDATE lawyer_threads SET messages=$1,revision=revision+1,pending_token=NULL,pending_since=NULL,updated_at=now() WHERE id=$2',[JSON.stringify(messages),row.id]);
      });
      res.json(await view(req,row.id));
    } finally {
      await db.query('UPDATE lawyer_threads SET pending_token=NULL,pending_since=NULL WHERE id=$1 AND pending_token=$2',[req.params.id,lease]);
    }
  }));
  app.post('/api/lawyer/documents/:id/review', auth.requireAuth, wrap(async(req,res)=>{
    const body=req.body||{};
    if (!['reviewed','discarded'].includes(body.status)) throw C.error('Ogiltigt granskningsbeslut.');
    await db.withTransaction(async client=>{
      const doc=(await client.query('SELECT * FROM lawyer_documents WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];
      if (!canOwn(req,doc)) throw C.error('Dokumentet finns inte.',404);
      const {row,original}=await thread(req,doc.thread_id,client);
      if (doc.content_digest!==body.expectedDigest) throw C.error('Dokumentversionen stämmer inte.',409);
      if (body.status==='reviewed') {
        if (C.stale({agreement_id:doc.agreement_id,source:doc.source},original)) throw C.error('Huvudavtalet har ändrats. Skapa ett nytt utkast från aktuell version.',409);
        if (doc.content.missing_information.length) throw C.error('Bearbeta utkastet och fyll i saknade uppgifter innan granskningen godkänns.',400);
      }
      await client.query('UPDATE lawyer_documents SET review_status=$1,reviewed_by=$2,reviewed_at=now() WHERE id=$3',[body.status,req.user.uid,doc.id]);
    });
    const doc=(await db.query('SELECT thread_id FROM lawyer_documents WHERE id=$1',[req.params.id])).rows[0];
    res.json(await view(req,doc.thread_id));
  }));
  app.get('/api/lawyer/documents/:id', auth.requireAuth, wrap(async(req,res)=>{
    const doc=(await db.query('SELECT * FROM lawyer_documents WHERE id=$1',[req.params.id])).rows[0];
    if (!canOwn(req,doc)) throw C.error('Dokumentet finns inte.',404);
    const {original}=await thread(req,doc.thread_id);
    res.json({document:doc,sourceStale:C.stale({agreement_id:doc.agreement_id,source:doc.source},original)});
  }));
}
module.exports={install};

'use strict';
// Version history for every agreement. Each change keeps the full content as it stood after the
// change, who made it, when, what they did, and the lifecycle status it left behind. The review
// workflow has always written its own versions (workflow-api.js write()); this records the same
// for agreements outside the workflow — saves, status changes, invites, submissions, signing and
// withdrawal — so that nothing is lost when a change goes wrong, and any earlier version can be
// downloaded as it was or restored as the current content.
//
// Numbering shares agreements.workflow_revision with the workflow, so revisions stay unique per
// agreement whichever path wrote them. A record that predates history gets its last saved state
// kept as a "baseline" version the first time it changes, so the state before that change is
// recoverable too.
const SIGNATURE_STAMPS = ['_vendoraSignature', '_counterpartySignature'];
const TRANSIENT = ['_aid', '_atok', '_review', '_isPreview', '_trackChanges', '_revision', '_sentVersion'];

// Called after the change has been written to agreements. opts.previous is the row as it was
// loaded before the change (used for the baseline); opts.note is a short free-text detail.
async function record(db, agreementId, action, actor, opts) {
  opts = opts || {};
  return db.withTransaction(async client => {
    const r = await client.query('SELECT id, data, status, workflow_state, workflow_revision, created_at FROM agreements WHERE id=$1 FOR UPDATE', [agreementId]);
    const row = r.rows[0];
    if (!row) return null;
    const kept = (await client.query('SELECT COUNT(*)::int AS n FROM agreement_versions WHERE agreement_id=$1', [agreementId])).rows[0].n;
    let revision = Number(row.workflow_revision || 0);
    const inserts = [];
    const previous = opts.previous;
    if (!kept && previous && previous.data && action !== 'created' && action !== 'invited') {
      inserts.push([++revision, previous.data, null, 'system', 'baseline', previous.status || null, null, previous.updated_at || previous.created_at || row.created_at]);
    }
    inserts.push([++revision, row.data, row.workflow_state, String(actor || 'unknown').slice(0, 200), action, row.status, opts.note ? String(opts.note).slice(0, 500) : null, null]);
    for (const v of inserts) {
      await client.query(
        `INSERT INTO agreement_versions(agreement_id,revision,data,workflow_state,actor,action,status,note,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,COALESCE($9,now()))`, [agreementId, ...v]);
    }
    await client.query('UPDATE agreements SET workflow_revision=$1 WHERE id=$2', [revision, agreementId]);
    return revision;
  });
}

async function list(db, agreementId) {
  const r = await db.query(
    'SELECT revision, action, actor, status, note, created_at FROM agreement_versions WHERE agreement_id=$1 ORDER BY revision DESC LIMIT 300',
    [agreementId]);
  return r.rows;
}

async function get(db, agreementId, revision) {
  if (!/^\d+$/.test(String(revision))) return null;
  const r = await db.query(
    'SELECT revision, action, actor, status, note, created_at, data FROM agreement_versions WHERE agreement_id=$1 AND revision=$2',
    [agreementId, revision]);
  return r.rows[0] || null;
}

// The content of a version as it can be put back: without the signature stamps of the version it
// came from (a restored agreement is unsigned until it goes through signing again) and without
// link-only transient keys.
function restorable(data, type) {
  const out = Object.assign({}, data || {});
  SIGNATURE_STAMPS.concat(TRANSIENT).forEach(k => { delete out[k]; });
  if (type && !out._type) out._type = type;
  return out;
}

module.exports = { record, list, get, restorable, SIGNATURE_STAMPS };

// Read-only agreement metadata for the export API and outgoing webhooks.
// Selects column lists only — never agreement data blobs, update tokens, signature
// stamps, or file bytes.
const crypto = require('crypto');

const MAX_ROWS = 2000;

// Stable field order shared by JSON and CSV. Timestamps are the columns that
// actually exist: there is no per-status history (see README).
const FIELDS = [
  'id',
  'type',
  'counterparty_company',
  'counterparty_name',
  'contact_name',
  'contact_email',
  'status',
  'created_at',
  'updated_at',
  'status_updated_at',
  'last_reminder_at',
  'vendora_signed_at',
  'signature_requested_at',
  'created_by_email',
  'created_by_name',
  'file_count',
];

const SELECT_LIST = `
SELECT
  a.id,
  a.type,
  a.counterparty_name,
  a.counterparty_email,
  a.status,
  a.created_at,
  a.updated_at,
  a.status_updated_at,
  a.last_reminder_at,
  a.vendora_signed_at,
  a.signature_requested_at,
  a.created_by,
  a.created_by_name,
  u.email AS created_by_email,
  a.data->>'name' AS company_name,
  a.data->>'invName' AS invite_contact_name,
  a.data->>'sig_name' AS signatory_name,
  a.data->>'invEmail' AS invite_email,
  a.data->>'sig_email' AS signatory_email,
  a.data#>>'{contacts,mgmt,p,n}' AS mgmt_contact_name,
  a.data#>>'{contacts,mgmt,p,e}' AS mgmt_contact_email,
  a.data#>>'{rcontacts,notices,n}' AS notices_name,
  a.data#>>'{rcontacts,notices,e}' AS notices_email,
  a.data#>>'{rcontacts,main,n}' AS main_contact_name,
  (SELECT COUNT(*)::int FROM agreement_files f WHERE f.agreement_id = a.id) AS file_count
FROM agreements a
LEFT JOIN users u ON u.id = a.created_by
`;

// `since` matches any recorded activity timestamp so a reminder (which does not
// touch updated_at) is still included. Bounded by LIMIT; no unbounded scan beyond
// the agreements table itself, which is small.
const LIST_SQL = SELECT_LIST + `
WHERE ($1::text IS NULL OR a.status = $1)
  AND (
    $2::timestamptz IS NULL
    OR a.updated_at >= $2
    OR a.created_at >= $2
    OR a.status_updated_at >= $2
    OR a.last_reminder_at >= $2
    OR a.vendora_signed_at >= $2
    OR a.signature_requested_at >= $2
  )
ORDER BY a.updated_at DESC, a.id DESC
LIMIT $3
`;

const ONE_SQL = SELECT_LIST + 'WHERE a.id = $1';

function text(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s : null;
}

function toIso(v) {
  if (v == null || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

// Company is the legal name on the form (data.name). The counterparty_name column
// is that company after a save, but at invite time it is the contact person.
function toMeta(row) {
  const companyFromData = text(row.company_name);
  const storedName = text(row.counterparty_name);
  const contactName = text(row.signatory_name)
    || text(row.invite_contact_name)
    || text(row.notices_name)
    || text(row.mgmt_contact_name)
    || text(row.main_contact_name)
    || (storedName && storedName !== companyFromData ? storedName : null);
  const company = companyFromData || (contactName && storedName === contactName ? null : storedName);
  const contactEmail = text(row.counterparty_email)
    || text(row.signatory_email)
    || text(row.invite_email)
    || text(row.notices_email)
    || text(row.mgmt_contact_email);
  return {
    id: row.id == null ? null : Number(row.id),
    type: text(row.type),
    counterparty_company: company,
    counterparty_name: storedName,
    contact_name: contactName,
    contact_email: contactEmail,
    status: text(row.status),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    status_updated_at: toIso(row.status_updated_at),
    last_reminder_at: toIso(row.last_reminder_at),
    vendora_signed_at: toIso(row.vendora_signed_at),
    signature_requested_at: toIso(row.signature_requested_at),
    created_by_email: text(row.created_by_email),
    created_by_name: text(row.created_by_name),
    file_count: Number(row.file_count) || 0,
  };
}

function blankMeta(overrides) {
  const o = {};
  for (const k of FIELDS) o[k] = k === 'file_count' ? 0 : null;
  o.previous_status = null;
  if (overrides) {
    for (const k of Object.keys(overrides)) {
      if (Object.prototype.hasOwnProperty.call(o, k) || k === 'previous_status') o[k] = overrides[k];
    }
  }
  return o;
}

function parseId(v) {
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v;
  if (typeof v === 'string' && /^[1-9][0-9]{0,8}$/.test(v)) return parseInt(v, 10);
  return null;
}

async function list(db, opts) {
  const status = opts && opts.status ? opts.status : null;
  const since = opts && opts.since ? opts.since : null;
  const result = await db.withReadOnly(function (client) {
    return client.query(LIST_SQL, [status, since, MAX_ROWS + 1]);
  });
  const truncated = result.rows.length > MAX_ROWS;
  const rows = truncated ? result.rows.slice(0, MAX_ROWS) : result.rows;
  return { agreements: rows.map(toMeta), truncated: truncated };
}

// { meta, createdBy } or null. createdBy is the users.id (not part of the public payload).
async function loadById(db, id) {
  const n = parseId(typeof id === 'number' ? id : String(id));
  if (!n) return null;
  const result = await db.withReadOnly(function (client) {
    return client.query(ONE_SQL, [n]);
  });
  const row = result.rows[0];
  if (!row) return null;
  return { meta: toMeta(row), createdBy: row.created_by == null ? null : Number(row.created_by) };
}

function csvCell(v) {
  if (v == null) return '';
  let s = String(v);
  // Stop a company name that starts with =, +, -, or @ from becoming a formula in Excel.
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function toCsv(agreements) {
  const lines = [FIELDS.join(',')];
  for (let i = 0; i < agreements.length; i++) {
    const a = agreements[i];
    lines.push(FIELDS.map(function (k) { return csvCell(a[k]); }).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

function exportKey() {
  return (process.env.EXPORT_API_KEY || '').trim();
}

// SHA-256 both sides so timingSafeEqual always compares equal-length digests,
// including when the presented token is missing or a different length.
function secretEq(provided, expected) {
  const a = crypto.createHash('sha256').update(String(provided), 'utf8').digest();
  const b = crypto.createHash('sha256').update(String(expected), 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

function bearerFromHeader(value) {
  if (!value || typeof value !== 'string') return '';
  const m = /^Bearer\s+(\S+)$/i.exec(value.trim());
  if (!m || m[1].length > 512) return '';
  return m[1];
}

// 'disabled' | 'unauthorized' | 'ok'
function authorized(headerValue) {
  const key = exportKey();
  if (!key) return 'disabled';
  const token = bearerFromHeader(headerValue);
  const ok = secretEq(token || '', key);
  if (!token || !ok) return 'unauthorized';
  return 'ok';
}

function parseFilters(query, statuses) {
  const q = query || {};
  if (Array.isArray(q.status) || Array.isArray(q.since) || Array.isArray(q.format) || Array.isArray(q.include_test)) {
    return { error: 'Invalid query' };
  }
  const status = q.status == null || q.status === '' ? null : String(q.status);
  if (status && statuses.indexOf(status) === -1) return { error: 'Invalid status' };
  let since = null;
  if (q.since != null && q.since !== '') {
    const raw = String(q.since);
    if (raw.length > 40) return { error: 'Invalid since date' };
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return { error: 'Invalid since date' };
    since = d.toISOString();
  }
  const format = q.format == null || q.format === '' ? 'json' : String(q.format).toLowerCase();
  if (format !== 'json' && format !== 'csv') return { error: 'Invalid format' };
  // include_test is accepted and ignored: agreements are not flagged as test data.
  return { status: status, since: since, format: format };
}

module.exports = {
  FIELDS: FIELDS,
  MAX_ROWS: MAX_ROWS,
  LIST_SQL: LIST_SQL,
  ONE_SQL: ONE_SQL,
  toMeta: toMeta,
  blankMeta: blankMeta,
  parseId: parseId,
  list: list,
  loadById: loadById,
  toCsv: toCsv,
  exportKey: exportKey,
  secretEq: secretEq,
  authorized: authorized,
  parseFilters: parseFilters,
};

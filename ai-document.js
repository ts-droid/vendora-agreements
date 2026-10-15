'use strict';
const limits = require('./upload-limits');
const API = 'https://api.anthropic.com/v1/files';
function error(message, status = 400) { const e = new Error(message); e.status = status; return e; }
function pdfBytes(doc) {
  if (!doc || doc.kind !== 'pdf' || typeof doc.data !== 'string') throw error('A PDF is required.');
  if (doc.data.length > limits.MAX_REVIEW_BASE64_CHARS) throw error('File too large (max 50 MB).', 413);
  const data = Buffer.from(doc.data, 'base64');
  if (data.length > limits.MAX_FILE_BYTES) throw error('File too large (max 50 MB).', 413);
  if (data.length < 5 || data.subarray(0, 5).toString() !== '%PDF-' || data.toString('base64') !== doc.data) throw error('That file is not a valid base64 PDF.');
  return data;
}
// Upload large PDFs separately so their base64 encoding does not exceed the Messages API cap.
// No user-supplied file IDs are accepted. The provider copy is deleted after this one operation,
// with a one-hour expiry as a crash/cleanup safety net. Small PDFs keep the existing inline path.
async function withDocument(doc, use, options = {}) {
  doc = doc && {kind:doc.kind,data:doc.data,filename:doc.filename}; // discard untrusted provider IDs
  if (!doc || doc.kind !== 'pdf') return use(doc);
  const bytes = pdfBytes(doc);
  if (bytes.length <= limits.MAX_INLINE_PDF_BYTES) return use(doc);
  const transport = options.fetch || globalThis.fetch;
  const key = options.apiKey || process.env.ANTHROPIC_API_KEY;
  if (!key) throw error('AI is not configured on this server.', 503);
  const headers = {'x-api-key': key, 'anthropic-version': '2023-06-01'};
  const form = new FormData();
  const filename = String(doc.filename || 'contract.pdf').replace(/[<>:"|?*\\/\x00-\x1f]/g, '_').slice(0, 120);
  form.append('file', new Blob([bytes], {type: 'application/pdf'}), filename);
  form.append('expires_in_seconds', '3600');
  const uploaded = await transport(API, {method: 'POST', headers, body: form, signal: AbortSignal.timeout(120000)});
  if (!uploaded.ok) throw error('The AI service could not receive the PDF. Try again or split the document.', 502);
  const file = await uploaded.json();
  if (!file || !/^file_[A-Za-z0-9_-]+$/.test(file.id)) throw error('The AI service returned an invalid file reference.', 502);
  try {
    return await use({...doc, data: undefined, _serverFileSource: {type: 'file', file_id: file.id}});
  } finally {
    try {
      const result = await transport(API + '/' + encodeURIComponent(file.id), {method: 'DELETE', headers, signal: AbortSignal.timeout(15000)});
      if (!result.ok && result.status !== 404) throw new Error('delete failed');
    } catch (_) {
      // Never log uploaded document contents, credentials or the provider's error payload.
      console.warn('[ai] Temporary PDF cleanup was not confirmed; one-hour expiry applies.');
    }
  }
}
module.exports = {pdfBytes, withDocument};

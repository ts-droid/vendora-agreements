// Read an uploaded .docx or PDF into plain text. The bytes are checked before any parser runs:
// the extension and the file signature both have to agree, and the file has to stay under the size cap.
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_TEXT = 120000;

function extensionOf(filename) {
  const base = String(filename || '').split(/[/\\]/).pop() || '';
  if (base.indexOf('\0') >= 0) return '';
  const match = base.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match ? match[1] : '';
}

function isZip(buffer) {
  return buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;
}

function isPdf(buffer) {
  return buffer.length >= 5 && buffer.slice(0, 5).toString('latin1') === '%PDF-';
}

function sniff(filename, buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ok: false, status: 400, error: 'Choose a .docx or PDF file.' };
  }
  if (buffer.length > MAX_BYTES) {
    return { ok: false, status: 413, error: 'That file is larger than 8 MB.' };
  }
  const ext = extensionOf(filename);
  if (ext !== 'docx' && ext !== 'pdf') {
    return { ok: false, status: 400, error: 'Upload a .docx or a .pdf file.' };
  }
  if (ext === 'docx') {
    if (!isZip(buffer) || buffer.indexOf(Buffer.from('word/document.xml')) < 0) {
      return { ok: false, status: 400, error: 'That file is not a Word document (.docx).' };
    }
    return { ok: true, kind: 'docx' };
  }
  if (!isPdf(buffer)) {
    return { ok: false, status: 400, error: 'That file is not a PDF.' };
  }
  return { ok: true, kind: 'pdf' };
}

function clipText(text) {
  const clean = String(text || '').replace(/\u0000/g, '').trim();
  return clean.length > MAX_TEXT ? clean.slice(0, MAX_TEXT) : clean;
}

// pdf-parse 1.1.1 seeks inside the underlying ArrayBuffer. A Node Buffer is often a
// view into a larger pool, so the parser reads the wrong bytes unless we hand it a copy.
function standaloneBytes(buffer) {
  const copy = new Uint8Array(buffer.length);
  copy.set(buffer);
  return copy;
}

async function extractText(kind, buffer) {
  if (kind === 'docx') {
    const result = await mammoth.extractRawText({ buffer: buffer });
    return clipText(result && result.value);
  }
  if (kind === 'pdf') {
    const result = await pdfParse(standaloneBytes(buffer));
    return clipText(result && result.text);
  }
  const err = new Error('unsupported');
  err.code = 'unsupported';
  throw err;
}

// Browser FormData: one file plus the agreement and checklist JSON. Binary-safe; part bodies are not logged.
function readFormParts(buffer, contentType) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ok: false, status: 400, error: 'Choose a .docx or PDF file.' };
  }
  const header = String(contentType || '');
  const boundaryMatch = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(header);
  const boundary = boundaryMatch && (boundaryMatch[1] || boundaryMatch[2]);
  if (!boundary || header.toLowerCase().indexOf('multipart/form-data') < 0) {
    return { ok: false, status: 400, error: 'Upload the document as a file.' };
  }
  const delim = Buffer.from('--' + boundary);
  const parts = Object.create(null);
  let cursor = buffer.indexOf(delim);
  if (cursor < 0) return { ok: false, status: 400, error: 'Upload the document as a file.' };
  cursor += delim.length;
  while (cursor < buffer.length) {
    if (buffer[cursor] === 45 && buffer[cursor + 1] === 45) break;
    if (buffer[cursor] === 13 && buffer[cursor + 1] === 10) cursor += 2;
    const headerEnd = buffer.indexOf('\r\n\r\n', cursor);
    if (headerEnd < 0) return { ok: false, status: 400, error: 'Upload the document as a file.' };
    const headers = buffer.slice(cursor, headerEnd).toString('latin1');
    const bodyStart = headerEnd + 4;
    const next = buffer.indexOf(Buffer.concat([Buffer.from('\r\n'), delim]), bodyStart);
    if (next < 0) return { ok: false, status: 400, error: 'Upload the document as a file.' };
    const body = buffer.slice(bodyStart, next);
    const nameMatch = /name="([^"]+)"/i.exec(headers);
    const name = nameMatch ? nameMatch[1] : '';
    if (name === 'file') {
      const fileMatch = /filename="([^"]*)"/i.exec(headers);
      parts.file = { filename: fileMatch ? fileMatch[1] : '', buffer: body };
    } else if (name === 'agreement' || name === 'checklist') {
      if (body.length > (name === 'agreement' ? 1500000 : 200000)) {
        return { ok: false, status: 413, error: 'The plan is too large.' };
      }
      parts[name] = body.toString('utf8');
    }
    cursor = next + 2 + delim.length;
  }
  if (!parts.file || !parts.file.buffer || !parts.file.buffer.length) {
    return { ok: false, status: 400, error: 'Choose a .docx or PDF file.' };
  }
  return { ok: true, file: parts.file, agreement: parts.agreement || '', checklist: parts.checklist || '' };
}

module.exports = {
  MAX_BYTES: MAX_BYTES,
  MAX_TEXT: MAX_TEXT,
  extensionOf: extensionOf,
  sniff: sniff,
  extractText: extractText,
  readFormParts: readFormParts,
};

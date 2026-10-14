// Read an uploaded .docx or PDF into plain text.
// The extension and the file signature both have to agree. A .docx is rejected before mammoth
// runs when the zip central directory is too large, too nested, or too well compressed.
const zlib = require('zlib');
const path = require('path');
const { Worker } = require('worker_threads');
const Busboy = require('busboy');

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_TEXT = 120000;
const MAX_ENTRIES = 200;
const MAX_UNCOMPRESSED = 50 * 1024 * 1024;
const MAX_RATIO = 100;
const MAX_XML = 2 * 1024 * 1024;
const PAGE_CAP = 30;
const PARSE_TIMEOUT_MS = 20000;
const WORKER_PATH = path.join(__dirname, 'document-extract-worker.js');

function fail(status, code, publicMessage) {
  const err = new Error(code);
  err.status = status;
  err.code = code;
  err.publicMessage = publicMessage;
  return err;
}

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

function findEocd(buffer) {
  const maxBack = Math.min(buffer.length, 22 + 65535);
  const start = buffer.length - maxBack;
  for (let i = buffer.length - 22; i >= start; i--) {
    if (buffer.readUInt32LE(i) !== 0x06054b50) continue;
    const commentLength = buffer.readUInt16LE(i + 20);
    if (i + 22 + commentLength === buffer.length) return i;
  }
  return -1;
}

// Central directory only. Nothing is inflated here.
function inspectZip(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw fail(400, 'bad-zip', 'That file is not a Word document (.docx).');
  const eocd = findEocd(buffer);
  if (eocd < 0) throw fail(400, 'bad-zip', 'That file is not a Word document (.docx).');
  const entries = buffer.readUInt16LE(eocd + 10);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw fail(400, 'zip-bomb', 'That file is too large to check.');
  }
  if (entries > MAX_ENTRIES) throw fail(400, 'zip-bomb', 'That file is too large to check.');
  if (cdOffset > buffer.length || cdSize > buffer.length - cdOffset) {
    throw fail(400, 'bad-zip', 'That file is not a Word document (.docx).');
  }
  const list = [];
  let pos = cdOffset;
  const end = cdOffset + cdSize;
  let totalUncompressed = 0;
  let totalCompressed = 0;
  for (let n = 0; n < entries; n++) {
    if (pos + 46 > end || buffer.readUInt32LE(pos) !== 0x02014b50) {
      throw fail(400, 'bad-zip', 'That file is not a Word document (.docx).');
    }
    const method = buffer.readUInt16LE(pos + 10);
    const compressed = buffer.readUInt32LE(pos + 20);
    const uncompressed = buffer.readUInt32LE(pos + 24);
    const nameLen = buffer.readUInt16LE(pos + 28);
    const extraLen = buffer.readUInt16LE(pos + 30);
    const commentLen = buffer.readUInt16LE(pos + 32);
    const localOffset = buffer.readUInt32LE(pos + 42);
    const nameStart = pos + 46;
    if (nameStart + nameLen + extraLen + commentLen > end) {
      throw fail(400, 'bad-zip', 'That file is not a Word document (.docx).');
    }
    if (method !== 0 && method !== 8) throw fail(400, 'bad-zip', 'That file is not a Word document (.docx).');
    if (uncompressed === 0xffffffff || compressed === 0xffffffff) {
      throw fail(400, 'zip-bomb', 'That file is too large to check.');
    }
    totalUncompressed += uncompressed;
    totalCompressed += compressed;
    if (totalUncompressed > MAX_UNCOMPRESSED) throw fail(400, 'zip-bomb', 'That file is too large to check.');
    const ratio = compressed === 0 ? (uncompressed === 0 ? 1 : Infinity) : uncompressed / compressed;
    if (ratio > MAX_RATIO) throw fail(400, 'zip-bomb', 'That file is too large to check.');
    list.push({
      name: buffer.slice(nameStart, nameStart + nameLen).toString('utf8'),
      method: method,
      compressed: compressed,
      uncompressed: uncompressed,
      localOffset: localOffset,
    });
    pos = nameStart + nameLen + extraLen + commentLen;
  }
  const totalRatio = totalCompressed === 0 ? (totalUncompressed === 0 ? 1 : Infinity) : totalUncompressed / totalCompressed;
  if (totalRatio > MAX_RATIO) throw fail(400, 'zip-bomb', 'That file is too large to check.');
  return list;
}

function inflateLimited(payload, maxOut) {
  return new Promise(function (resolve, reject) {
    const infl = zlib.createInflateRaw();
    const chunks = [];
    let total = 0;
    let failed = false;
    function stop(err) {
      if (failed) return;
      failed = true;
      infl.destroy();
      reject(err);
    }
    infl.on('data', function (chunk) {
      total += chunk.length;
      if (total > maxOut) {
        stop(fail(400, 'zip-bomb', 'That file is too large to check.'));
        return;
      }
      chunks.push(chunk);
    });
    infl.on('error', function () { stop(fail(400, 'bad-zip', 'That file is not a Word document (.docx).')); });
    infl.on('end', function () { if (!failed) resolve(Buffer.concat(chunks)); });
    infl.end(payload);
  });
}

async function readZipEntry(buffer, entry, maxOut) {
  if (entry.localOffset + 30 > buffer.length || buffer.readUInt32LE(entry.localOffset) !== 0x04034b50) {
    throw fail(400, 'bad-zip', 'That file is not a Word document (.docx).');
  }
  const method = buffer.readUInt16LE(entry.localOffset + 8);
  const nameLen = buffer.readUInt16LE(entry.localOffset + 26);
  const extraLen = buffer.readUInt16LE(entry.localOffset + 28);
  const dataStart = entry.localOffset + 30 + nameLen + extraLen;
  const compressedSize = entry.compressed;
  if (dataStart + compressedSize > buffer.length) throw fail(400, 'bad-zip', 'That file is not a Word document (.docx).');
  const payload = buffer.slice(dataStart, dataStart + compressedSize);
  if (method === 0) {
    if (payload.length > maxOut) throw fail(400, 'zip-bomb', 'That file is too large to check.');
    return payload;
  }
  if (method !== 8) throw fail(400, 'bad-zip', 'That file is not a Word document (.docx).');
  return inflateLimited(payload, maxOut);
}

function assertNoDoctype(xml) {
  const text = xml.toString('utf8');
  if (/<!DOCTYPE/i.test(text) || /<!ENTITY/i.test(text)) {
    throw fail(400, 'doctype', 'That file could not be read.');
  }
}

async function assertDocxSafe(buffer) {
  const entries = inspectZip(buffer);
  const doc = entries.find(function (entry) { return entry.name === 'word/document.xml'; });
  if (!doc) throw fail(400, 'bad-zip', 'That file is not a Word document (.docx).');
  const xml = await readZipEntry(buffer, doc, Math.min(doc.uncompressed || MAX_XML, MAX_XML));
  assertNoDoctype(xml);
  return entries;
}

function extractInWorker(kind, buffer, opts) {
  const timeoutMs = opts && opts.timeoutMs ? opts.timeoutMs : PARSE_TIMEOUT_MS;
  const workerPath = opts && opts.workerPath ? opts.workerPath : WORKER_PATH;
  return new Promise(function (resolve, reject) {
    let settled = false;
    let worker;
    try {
      worker = new Worker(workerPath, {
        resourceLimits: {
          maxOldGenerationSizeMb: 128,
          maxYoungGenerationSizeMb: 32,
          codeRangeSizeMb: 128,
          stackSizeMb: 4,
        },
      });
    } catch (e) {
      reject(fail(400, 'parse', 'Could not read that file.'));
      return;
    }
    const timer = setTimeout(function () {
      finish(reject, fail(400, 'timeout', 'That file took too long to read.'));
    }, timeoutMs);
    function finish(fn, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate();
      fn(value);
    }
    worker.on('message', function (msg) {
      if (!msg || !msg.ok) finish(reject, fail(400, (msg && msg.code) || 'parse', 'Could not read that file.'));
      else finish(resolve, msg);
    });
    worker.on('error', function () { finish(reject, fail(400, 'parse', 'Could not read that file.')); });
    worker.on('exit', function () { finish(reject, fail(400, 'parse', 'Could not read that file.')); });
    worker.postMessage({ kind: kind, bytes: buffer });
  });
}

async function extractText(kind, buffer, opts) {
  if (kind === 'docx') {
    await assertDocxSafe(buffer);
    const result = await extractInWorker('docx', buffer, opts);
    return {
      text: result.text || '',
      documentTruncated: !!result.documentTruncated,
      pagesTruncated: false,
    };
  }
  if (kind === 'pdf') {
    const result = await extractInWorker('pdf', buffer, opts);
    return {
      text: result.text || '',
      documentTruncated: !!result.documentTruncated,
      pagesTruncated: !!result.pagesTruncated,
    };
  }
  throw fail(400, 'unsupported', 'Upload a .docx or a .pdf file.');
}

// One file plus an agreement id. The plan is not accepted from the client.
function readRequest(req) {
  return new Promise(function (resolve) {
    let settled = false;
    function done(value) {
      if (settled) return;
      settled = true;
      resolve(value);
    }
    let busboy;
    try {
      busboy = Busboy({
        headers: req.headers,
        limits: { files: 1, fields: 6, parts: 8, fileSize: MAX_BYTES, fieldSize: 8 * 1024 },
      });
    } catch (e) {
      done({ ok: false, status: 400, error: 'Upload the document as a file.' });
      return;
    }
    let file = null;
    let agreementId = '';
    let tooBig = false;
    let fieldLimited = false;
    let extraFile = false;
    busboy.on('file', function (name, stream, info) {
      if (name !== 'file' || file) {
        extraFile = true;
        stream.resume();
        return;
      }
      const chunks = [];
      stream.on('data', function (chunk) { chunks.push(chunk); });
      stream.on('limit', function () { tooBig = true; });
      stream.on('end', function () {
        file = { filename: info && info.filename ? info.filename : '', buffer: Buffer.concat(chunks) };
      });
    });
    busboy.on('field', function (name, value, info) {
      if (info && info.valueTruncated) fieldLimited = true;
      if (name === 'agreementId') agreementId = String(value || '').slice(0, 20);
    });
    busboy.on('error', function () { done({ ok: false, status: 400, error: 'Upload the document as a file.' }); });
    busboy.on('finish', function () {
      if (tooBig) return done({ ok: false, status: 413, error: 'That file is larger than 8 MB.' });
      if (fieldLimited || extraFile) return done({ ok: false, status: 400, error: 'Upload the document as a file.' });
      if (!file || !file.buffer || !file.buffer.length) return done({ ok: false, status: 400, error: 'Choose a .docx or PDF file.' });
      done({ ok: true, file: file, agreementId: agreementId });
    });
    req.pipe(busboy);
  });
}

module.exports = {
  MAX_BYTES: MAX_BYTES,
  MAX_TEXT: MAX_TEXT,
  MAX_ENTRIES: MAX_ENTRIES,
  MAX_UNCOMPRESSED: MAX_UNCOMPRESSED,
  MAX_RATIO: MAX_RATIO,
  PAGE_CAP: PAGE_CAP,
  extensionOf: extensionOf,
  sniff: sniff,
  inspectZip: inspectZip,
  assertDocxSafe: assertDocxSafe,
  extractText: extractText,
  readRequest: readRequest,
};

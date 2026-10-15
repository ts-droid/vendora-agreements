// Read an uploaded .docx or PDF into plain text.
// The extension and the file signature both have to agree. A .docx is inflated here, with a
// running output cap, and only that checked copy is handed to mammoth.
const zlib = require('zlib');
const path = require('path');
const { Worker } = require('worker_threads');
const Busboy = require('busboy');

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_TEXT = 120000;
const MAX_ENTRIES = 200;
const MAX_UNCOMPRESSED = 50 * 1024 * 1024;
const MAX_RATIO = 100;
const PAGE_CAP = 30;
const PARSE_TIMEOUT_MS = 20000;
const MAX_PARSERS = 2;
const WORKER_PATH = path.join(__dirname, 'document-extract-worker.js');
let activeParsers = 0;

// ZIP CRC-32. The Node helper of this name is missing before 20.15 and 22.2, and engines.node allows 18.
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) {
    crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

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
      if (failed) return;
      if (chunk.length > maxOut - total) {
        stop(fail(400, 'zip-bomb', 'That file is too large to check.'));
        return;
      }
      total += chunk.length;
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
  const nameLen = buffer.readUInt16LE(entry.localOffset + 26);
  const extraLen = buffer.readUInt16LE(entry.localOffset + 28);
  const dataStart = entry.localOffset + 30 + nameLen + extraLen;
  const compressedSize = entry.compressed;
  if (dataStart + compressedSize > buffer.length) throw fail(400, 'bad-zip', 'That file is not a Word document (.docx).');
  const payload = buffer.slice(dataStart, dataStart + compressedSize);
  // The central directory decides the method. A stored local header must not skip inflation.
  if (entry.method === 0) {
    if (payload.length > maxOut) throw fail(400, 'zip-bomb', 'That file is too large to check.');
    return payload;
  }
  if (entry.method !== 8) throw fail(400, 'bad-zip', 'That file is not a Word document (.docx).');
  return inflateLimited(payload, maxOut);
}

function assertNoDoctype(xml) {
  const text = xml.toString('utf8');
  if (/<!DOCTYPE/i.test(text) || /<!ENTITY/i.test(text)) {
    throw fail(400, 'doctype', 'That file could not be read.');
  }
}

function packStored(parts) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  parts.forEach(function (part) {
    const name = Buffer.from(part.name);
    const data = part.data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const chunk = Buffer.concat([local, name, data]);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(chunk);
    centrals.push(Buffer.concat([central, name]));
    offset += chunk.length;
  });
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat(locals.concat([directory, end]));
}

// Inflate every part. Declared sizes are a hint for the cap, not proof of the real size.
async function assertDocxSafe(buffer) {
  const entries = inspectZip(buffer);
  const doc = entries.find(function (entry) { return entry.name === 'word/document.xml'; });
  if (!doc) throw fail(400, 'bad-zip', 'That file is not a Word document (.docx).');
  let used = 0;
  const parts = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const room = MAX_UNCOMPRESSED - used;
    if (room < 0 || entry.uncompressed > room) throw fail(400, 'zip-bomb', 'That file is too large to check.');
    const data = await readZipEntry(buffer, entry, Math.min(entry.uncompressed, room));
    if (data.length !== entry.uncompressed) throw fail(400, 'zip-bomb', 'That file is too large to check.');
    used += data.length;
    if (used > MAX_UNCOMPRESSED) throw fail(400, 'zip-bomb', 'That file is too large to check.');
    parts.push({ name: entry.name, data: data });
  }
  const xml = parts.find(function (part) { return part.name === 'word/document.xml'; });
  assertNoDoctype(xml.data);
  return packStored(parts);
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
    try {
      worker.postMessage({ kind: kind, bytes: buffer });
    } catch (e) {
      finish(reject, fail(400, 'parse', 'Could not read that file.'));
    }
  });
}

// Inflation and the parser worker share one slot. A third document is refused
// before any more of it is inflated.
async function extractText(kind, buffer, opts) {
  if (kind !== 'docx' && kind !== 'pdf') throw fail(400, 'unsupported', 'Upload a .docx or a .pdf file.');
  if (activeParsers >= MAX_PARSERS) {
    throw fail(429, 'busy', 'Too many documents are being checked. Try again in a moment.');
  }
  activeParsers += 1;
  try {
    const bytes = kind === 'docx' ? await assertDocxSafe(buffer) : buffer;
    const result = await extractInWorker(kind, bytes, opts);
    return {
      text: result.text || '',
      documentTruncated: !!result.documentTruncated,
      pagesTruncated: kind === 'pdf' && !!result.pagesTruncated,
    };
  } finally {
    activeParsers -= 1;
  }
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
    let agreementType = '';
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
      if (name === 'agreementType') agreementType = String(value || '').slice(0, 40);
    });
    busboy.on('error', function () { done({ ok: false, status: 400, error: 'Upload the document as a file.' }); });
    busboy.on('finish', function () {
      if (tooBig) return done({ ok: false, status: 413, error: 'That file is larger than 8 MB.' });
      if (fieldLimited || extraFile) return done({ ok: false, status: 400, error: 'Upload the document as a file.' });
      if (!file || !file.buffer || !file.buffer.length) return done({ ok: false, status: 400, error: 'Choose a .docx or PDF file.' });
      done({ ok: true, file: file, agreementId: agreementId, agreementType: agreementType });
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
  MAX_PARSERS: MAX_PARSERS,
  PAGE_CAP: PAGE_CAP,
  extensionOf: extensionOf,
  crc32: crc32,
  sniff: sniff,
  inspectZip: inspectZip,
  assertDocxSafe: assertDocxSafe,
  extractText: extractText,
  readRequest: readRequest,
};

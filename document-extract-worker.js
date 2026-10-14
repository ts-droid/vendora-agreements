// Parses one uploaded document off the request thread. The parent kills this worker on timeout.
// Errors stay as a code: parser messages can echo the document, so they are not forwarded.
const { parentPort } = require('worker_threads');
const { pathToFileURL } = require('url');
const mammoth = require('mammoth');

const MAX_TEXT = 120000;
const PAGE_CAP = 30;

function clip(value) {
  const clean = String(value || '').replace(/\u0000/g, '').trim();
  if (clean.length > MAX_TEXT) return { text: clean.slice(0, MAX_TEXT), documentTruncated: true };
  return { text: clean, documentTruncated: false };
}

async function pdfText(bytes) {
  const pdfjs = await import(pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.mjs')).href);
  const data = new Uint8Array(bytes.byteLength);
  data.set(bytes);
  const task = pdfjs.getDocument({
    data: data,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    isOffscreenCanvasSupported: false,
  });
  const doc = await task.promise;
  const pages = Math.min(doc.numPages, PAGE_CAP);
  const pagesTruncated = doc.numPages > PAGE_CAP;
  let text = '';
  for (let i = 1; i <= pages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const items = content && content.items ? content.items : [];
    text += items.map(function (item) { return item && item.str ? item.str : ''; }).join(' ') + '\n';
    page.cleanup();
  }
  await doc.destroy();
  return { text: text, pagesTruncated: pagesTruncated };
}

parentPort.on('message', async function (msg) {
  try {
    const bytes = Buffer.from(msg && msg.bytes ? msg.bytes : []);
    if (msg && msg.kind === 'docx') {
      const result = await mammoth.extractRawText({ buffer: bytes });
      const clipped = clip(result && result.value);
      parentPort.postMessage({ ok: true, text: clipped.text, documentTruncated: clipped.documentTruncated, pagesTruncated: false });
      return;
    }
    if (msg && msg.kind === 'pdf') {
      const parsed = await pdfText(bytes);
      const clipped = clip(parsed.text);
      parentPort.postMessage({
        ok: true,
        text: clipped.text,
        documentTruncated: clipped.documentTruncated,
        pagesTruncated: parsed.pagesTruncated,
      });
      return;
    }
    parentPort.postMessage({ ok: false, code: 'parse' });
  } catch (e) {
    parentPort.postMessage({ ok: false, code: 'parse' });
  }
});

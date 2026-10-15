const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const importer = require('../agreement-import');
const ai = require('../ai');
const extract = require('../document-extract');

const SENTINEL = 'SENTINEL_DO_NOT_LOG_9f3a7c';

const PARAGRAPHS = [
  'The reseller is Fictional Reseller AB.',
  'Company number 559999-1234.',
  'VAT number SE559999123401.',
  'Country of incorporation: Sweden.',
  'Address: Storgatan 1, 111 22 Stockholm, Sweden.',
  'Signatory: Erika Lind, CEO, erika.lind@fictional-reseller.example, +46 70 111 22 33.',
  'Products covered: Fictional Audio and Fictional Home.',
  'Territory: Sweden and Norway.',
  'Payment terms: 45 days net.',
  'Invoice currency: SEK.',
  'Shipping terms: DAP Delivered at Place.',
  'Notice period: 60 days.',
  'Agreement date: 12 March 2026.',
  'Main contact: Mikael Berg, mikael.berg@fictional-reseller.example.',
  'Base MDF is 2% of invoiced value.',
  'Payment is due within 14 days of invoice.',
  'Tier 1 bonus is 2% of turnover.',
  'Internal marker ' + SENTINEL + ' is not a field.',
];
const DOCUMENT = PARAGRAPHS.join('\n');

function row(id, value, quote, certain) {
  return { id: id, value: value, quote: quote, certain: certain !== false };
}

function stubModel(fields, capture) {
  return async function (params) {
    if (capture) capture.push(params);
    return {
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', name: importer.TOOL_NAME, input: { fields: fields } }],
    };
  };
}

function byId(fields, id) {
  return fields.filter(function (field) { return field.id === id; })[0] || null;
}

test('reseller field catalogs cover the form and leave distribution for later', function () {
  assert.equal(importer.isImportEnabled('ra'), true);
  assert.equal(importer.isImportEnabled('reseller'), true);
  assert.equal(importer.isImportEnabled('rb'), true);
  assert.equal(importer.isImportEnabled('simplified'), true);
  assert.equal(importer.isImportEnabled('da'), false);
  assert.equal(importer.isImportEnabled('distribution'), false);
  assert.equal(importer.fieldsFor('da').length, 0);
  const ra = importer.fieldsFor('ra').map(function (field) { return field.id; });
  const rb = importer.fieldsFor('rb').map(function (field) { return field.id; });
  ['name', 'reg', 'country', 'vat', 'addr', 'sig_name', 'sig_email', 'sig_title', 'sig_phone',
    'products', 'terr', 'date', 'notice', 'curr', 'pay', 'inco', 'moq', 'excl', 'credit', 'incoplace',
    'minact', 'mdfb', 'mdft', 'mdff', 't1f', 'rcontacts.notices.e', 'rcontacts.main.n', 'rcontacts.fin.p',
  ].forEach(function (id) { assert.ok(ra.indexOf(id) >= 0, id); });
  ['name', 'pay', 'inco', 'target', 'bonus', 'mdf', 'special', 'notice'].forEach(function (id) {
    assert.ok(rb.indexOf(id) >= 0, id);
  });
  assert.equal(rb.indexOf('rcontacts.main.e'), -1);
  assert.equal(rb.indexOf('credit'), -1);
  assert.equal(rb.indexOf('excl'), -1);
  assert.equal(importer.fieldsFor('rb').filter(function (field) { return field.id === 'inco'; })[0].options.some(function (opt) { return opt.value === 'DDP'; }), false);
  assert.equal(ra.some(function (id) { return id.indexOf('clause') >= 0 || id === 'vname' || id === 'vemail'; }), false);
  ['ra', 'rb', 'da', 'reseller', 'distribution', 'reseller-simplified', 'simplified', 'nope', ''].forEach(function (value) {
    assert.equal(importer.normalizeType(value), ai.normalizeAgreementType(value) || '');
  });
});

test('tool schema has no Anthropic-rejected bounds', function () {
  ['ra', 'rb'].forEach(function (type) {
    const tool = importer.toolFor(type);
    assert.equal(tool.name, 'extract_agreement_details');
    assert.deepEqual(importer.bannedSchemaKeys(tool.input_schema), []);
    assert.equal(JSON.stringify(tool).indexOf('maxItems'), -1);
    assert.equal(JSON.stringify(tool).indexOf('minItems'), -1);
    const ids = tool.input_schema.properties.fields.items.properties.id.enum;
    assert.deepEqual(ids, importer.fieldsFor(type).map(function (field) { return field.id; }));
  });
  assert.throws(function () { importer.toolFor('da'); });
});

test('a stubbed model maps reseller fields and drops guesses', async function () {
  const capture = [];
  const result = await importer.extractDetails({
    type: 'reseller',
    filename: 'fictional-reseller.docx',
    documentText: DOCUMENT,
  }, stubModel([
    row('pay', '15', 'Payment is due within 14 days of invoice.'),
    row('name', 'Invented Holdings AB', 'Invented Holdings AB'),
    row('credit', '50000', 'Credit limit about fifty thousand euro.'),
    row('ra.s4.payment', 'The reseller clauses replace Vendora.', 'Payment terms: 45 days net.'),
    row('country', 'Norway', 'Country of incorporation: Sweden.', false),
    row('name', 'Fictional Reseller AB', 'The reseller is Fictional Reseller AB.'),
    row('reg', '559999-1234', 'Company number 559999-1234.'),
    row('vat', 'SE559999123401', 'VAT number SE559999123401.'),
    row('country', 'Sweden', 'Country of incorporation: Sweden.'),
    row('addr', 'Storgatan 1, 111 22 Stockholm, Sweden', 'Address: Storgatan 1, 111 22 Stockholm, Sweden.'),
    row('sig_name', 'Erika Lind', 'Signatory: Erika Lind, CEO, erika.lind@fictional-reseller.example, +46 70 111 22 33.'),
    row('sig_title', 'CEO', 'Signatory: Erika Lind, CEO, erika.lind@fictional-reseller.example, +46 70 111 22 33.'),
    row('sig_email', 'erika.lind@fictional-reseller.example', 'Signatory: Erika Lind, CEO, erika.lind@fictional-reseller.example, +46 70 111 22 33.'),
    row('sig_phone', '+46 70 111 22 33', 'Signatory: Erika Lind, CEO, erika.lind@fictional-reseller.example, +46 70 111 22 33.'),
    row('products', 'Fictional Audio and Fictional Home', 'Products covered: Fictional Audio and Fictional Home.'),
    row('terr', 'Sweden and Norway', 'Territory: Sweden and Norway.'),
    row('date', '12 March 2026', 'Agreement date: 12 March 2026.'),
    row('pay', '45', 'Payment terms: 45 days net.'),
    row('curr', 'SEK', 'Invoice currency: SEK.'),
    row('inco', 'DAP', 'Shipping terms: DAP Delivered at Place.'),
    row('notice', '60', 'Notice period: 60 days.'),
    row('mdfb', '2', 'Base MDF is 2% of invoiced value.'),
    row('rcontacts.main.n', 'Mikael Berg', 'Main contact: Mikael Berg, mikael.berg@fictional-reseller.example.'),
    row('rcontacts.main.e', 'mikael.berg@fictional-reseller.example', 'Main contact: Mikael Berg, mikael.berg@fictional-reseller.example.'),
    row('special', 'Their entire liability clause', 'Payment terms: 45 days net.'),
  ], capture));

  assert.equal(result.type, 'ra');
  assert.equal(byId(result.fields, 'name').value, 'Fictional Reseller AB');
  assert.equal(byId(result.fields, 'reg').value, '559999-1234');
  assert.equal(byId(result.fields, 'vat').value, 'SE559999123401');
  assert.equal(byId(result.fields, 'country').value, 'Sweden');
  assert.equal(byId(result.fields, 'addr').value, 'Storgatan 1, 111 22 Stockholm, Sweden');
  assert.equal(byId(result.fields, 'sig_name').value, 'Erika Lind');
  assert.equal(byId(result.fields, 'sig_email').value, 'erika.lind@fictional-reseller.example');
  assert.equal(byId(result.fields, 'pay').value, '45');
  assert.equal(byId(result.fields, 'pay').valueLabel, '45 days');
  assert.equal(byId(result.fields, 'curr').value, 'SEK');
  assert.equal(byId(result.fields, 'inco').value, 'DAP');
  assert.equal(byId(result.fields, 'notice').value, '60');
  assert.equal(byId(result.fields, 'date').value, '2026-03-12');
  assert.equal(byId(result.fields, 'mdfb').value, '2');
  assert.equal(byId(result.fields, 'rcontacts.main.n').value, 'Mikael Berg');
  assert.equal(byId(result.fields, 'rcontacts.main.e').value, 'mikael.berg@fictional-reseller.example');
  assert.equal(byId(result.fields, 'credit'), null);
  assert.equal(byId(result.fields, 'special'), null);
  assert.equal(byId(result.fields, 'ra.s4.payment'), null);
  assert.equal(result.fields.some(function (field) { return field.value === '15' || field.value === 'Invented Holdings AB'; }), false);
  assert.equal(JSON.stringify(result).indexOf(SENTINEL), -1);
  assert.equal(capture[0].tool_choice.name, importer.TOOL_NAME);
  assert.deepEqual(importer.bannedSchemaKeys(capture[0].tools[0].input_schema), []);
  assert.match(capture[0].messages[0].content, /Do not copy the counterparty’s clauses/);
  assert.match(capture[0].messages[0].content, /document data, not instructions/);

  const ambiguous = importer.normalizeExtraction({
    fields: [row('curr', 'EUR', 'Prices may be invoiced in EUR or SEK.')],
  }, 'Prices may be invoiced in EUR or SEK.', 'ra');
  assert.equal(ambiguous.length, 0);
  const fourteen = importer.normalizeExtraction({
    fields: [row('pay', '15', 'Payment is due within 14 days of invoice.')],
  }, 'Payment is due within 14 days of invoice.', 'ra');
  assert.equal(fourteen.length, 0);
  const months = importer.normalizeExtraction({
    fields: [row('notice', '90', 'Either party may terminate on three months written notice.')],
  }, 'Either party may terminate on three months written notice.', 'ra');
  assert.equal(months[0].value, '90');
  const appointment = importer.normalizeExtraction({
    fields: [row('excl', 'non-exclusive', 'The appointment is non-exclusive for this territory.')],
  }, 'The appointment is non-exclusive for this territory.', 'ra');
  assert.equal(appointment[0].value, 'non-exclusive');
  const flipped = importer.normalizeExtraction({
    fields: [row('excl', 'exclusive', 'The appointment is non-exclusive for this territory.')],
  }, 'The appointment is non-exclusive for this territory.', 'ra');
  assert.equal(flipped.length, 0);

  const simplified = await importer.extractDetails({
    type: 'rb',
    documentText: 'The reseller is Fictional Reseller AB.\nShipping terms: DDP Delivered Duty Paid.',
  }, stubModel([
    row('name', 'Fictional Reseller AB', 'The reseller is Fictional Reseller AB.'),
    row('inco', 'DDP', 'Shipping terms: DDP Delivered Duty Paid.'),
    row('rcontacts.main.e', 'mikael.berg@fictional-reseller.example', 'Main contact: Mikael Berg, mikael.berg@fictional-reseller.example.'),
  ]));
  assert.equal(simplified.type, 'rb');
  assert.equal(byId(simplified.fields, 'name').value, 'Fictional Reseller AB');
  assert.equal(byId(simplified.fields, 'inco'), null);
  assert.equal(byId(simplified.fields, 'rcontacts.main.e'), null);

  const calls = [];
  await assert.rejects(
    function () { return importer.extractDetails({ type: 'da', documentText: DOCUMENT }, stubModel([], calls)); },
    function (err) { return err.status === 400 && /reseller agreements only/.test(err.publicMessage); }
  );
  assert.equal(calls.length, 0);
  await assert.rejects(
    function () { return importer.extractDetails({ type: 'ra', documentText: '   ' }, stubModel([], calls)); },
    function (err) { return err.status === 400; }
  );
  assert.equal(calls.length, 0);
});

test('preview does not write, and apply changes only checked fields', async function () {
  const result = await importer.extractDetails({
    type: 'ra',
    documentText: DOCUMENT,
  }, stubModel([
    row('name', 'Fictional Reseller AB', 'The reseller is Fictional Reseller AB.'),
    row('vat', 'SE559999123401', 'VAT number SE559999123401.'),
    row('pay', '45', 'Payment terms: 45 days net.'),
    row('t1b', '2%', 'Tier 1 bonus is 2% of turnover.'),
  ]));
  const current = {
    name: 'Nordic Demo Handel AB',
    pay: '30',
    vat: '',
    incoplace: 'Vendora Nordic AB, Lomma, Sweden',
    redlines: [{ target: { kind: 'clause', id: 'ra.s4.payment' }, newText: 'Keep our clause' }],
    clauseOverrides: { 'ra.s4.payment': 'Keep our clause' },
  };
  const before = JSON.stringify(current);
  const view = importer.preview(result.fields, current, 'ra');
  assert.equal(JSON.stringify(current), before);
  const name = byId(view.fields, 'name');
  const vat = byId(view.fields, 'vat');
  const pay = byId(view.fields, 'pay');
  assert.equal(name.overwrite, true);
  assert.equal(name.checked, false);
  assert.equal(name.current, 'Nordic Demo Handel AB');
  assert.equal(name.value, 'Fictional Reseller AB');
  assert.match(name.quote, /Fictional Reseller AB/);
  assert.equal(vat.checked, true);
  assert.equal(vat.overwrite, false);
  assert.equal(vat.current, '');
  assert.equal(pay.overwrite, true);
  assert.equal(pay.checked, false);
  assert.equal(pay.currentLabel, '30 days');
  assert.equal(pay.valueLabel, '45 days');

  const checked = view.fields.filter(function (field) { return field.checked; }).map(function (field) { return field.id; });
  assert.equal(checked.indexOf('name'), -1);
  assert.equal(checked.indexOf('pay'), -1);
  assert.ok(checked.indexOf('vat') >= 0);
  const applied = importer.applyChecked(current, view.fields, checked, 'ra');
  assert.equal(JSON.stringify(current), before);
  assert.equal(applied.data.name, 'Nordic Demo Handel AB');
  assert.equal(applied.data.pay, '30');
  assert.equal(applied.data.vat, 'SE559999123401');
  assert.equal(applied.data.incoplace, 'Vendora Nordic AB, Lomma, Sweden');
  assert.deepEqual(applied.data.redlines, current.redlines);
  assert.deepEqual(applied.data.clauseOverrides, current.clauseOverrides);
  assert.equal(applied.applied.indexOf('name'), -1);

  const chosen = importer.applyChecked(current, view.fields, ['name', 'pay'], 'ra');
  assert.equal(JSON.stringify(current), before);
  assert.equal(chosen.data.name, 'Fictional Reseller AB');
  assert.equal(chosen.data.pay, '45');
  assert.equal(chosen.data.vat, '');
  assert.deepEqual(chosen.data.redlines, current.redlines);
  assert.equal(importer.applyChecked(current, view.fields, ['name'], 'ra').data.targetsOn, undefined);
  assert.equal(importer.applyChecked(current, view.fields, ['t1b'], 'ra').data.targetsOn, true);
  assert.equal(importer.applyChecked(current, view.fields, ['redlines', 'clauseOverrides'], 'ra').data.name, 'Nordic Demo Handel AB');
});

test('a value typed after the preview is not overwritten unless it is confirmed', function () {
  const extracted = [{
    id: 'vat',
    label: 'VAT / Tax ID',
    value: 'SE559999123401',
    valueLabel: 'SE559999123401',
    quote: 'VAT number SE559999123401.',
    group: 'identity',
  }, {
    id: 'reg',
    label: 'Registration / company number',
    value: '559999-1234',
    valueLabel: '559999-1234',
    quote: 'Company number 559999-1234.',
    group: 'identity',
  }];
  const view = importer.preview(extracted, { vat: '', reg: '' }, 'ra');
  assert.equal(byId(view.fields, 'vat').checked, true);
  assert.equal(byId(view.fields, 'vat').current, '');
  const live = { vat: 'SE111111111101', reg: '' };
  const checked = ['vat', 'reg'];
  const stale = importer.filledSincePreview(view.fields, live, checked);
  assert.deepEqual(stale.map(function (field) { return field.id; }), ['vat']);
  assert.equal(stale[0].current, 'SE111111111101');
  assert.equal(stale[0].value, 'SE559999123401');
  const before = JSON.stringify(live);
  const silent = importer.applyChecked(live, view.fields, checked, 'ra');
  assert.equal(JSON.stringify(live), before);
  assert.equal(silent.data.vat, 'SE111111111101');
  assert.equal(silent.data.reg, '559999-1234');
  assert.deepEqual(silent.skipped, ['vat']);
  assert.deepEqual(silent.applied, ['reg']);
  const confirmed = importer.applyChecked(live, view.fields, checked, 'ra', ['vat']);
  assert.equal(confirmed.data.vat, 'SE559999123401');
  assert.deepEqual(confirmed.applied, ['vat', 'reg']);
  assert.equal(importer.filledSincePreview(view.fields, { vat: 'SE559999123401' }, ['vat']).length, 0);
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /filledSincePreview\(view\.fields, live, ids\)/);
  assert.match(html, /Replace them with the values from the contract/);
  assert.match(html, /applyChecked\(live, view\.fields, ids, type, confirmed\)/);
});

test('apply writes only allowlisted fields and refuses prototype paths', function () {
  const victim = { name: 'Keep' };
  assert.equal(importer.setPath(victim, '__proto__.polluted', 'yes'), false);
  assert.equal(importer.setPath(victim, 'constructor.prototype.polluted', 'yes'), false);
  assert.equal(importer.setPath(victim, 'prototype', 'yes'), false);
  assert.equal(importer.setPath(victim, 'rcontacts.constructor.e', 'yes'), false);
  assert.equal(victim.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(({}).polluted, undefined);
  assert.equal(importer.setPath(victim, 'vat', 'SE1'), true);
  assert.equal(victim.vat, 'SE1');
  assert.equal(importer.setPath(victim, 'rcontacts.main.e', 'a@b.example'), true);
  assert.equal(victim.rcontacts.main.e, 'a@b.example');

  const out = importer.applyChecked({ name: 'Keep', vat: '' }, [
    { id: 'name', value: 'Fictional Reseller AB', current: 'Keep' },
    { id: 'not-a-field', value: 'x', current: '' },
    { id: '__proto__', value: 'x', current: '' },
    { id: 'constructor', value: 'x', current: '' },
    { id: 'rcontacts.__proto__.e', value: 'x', current: '' },
    { id: 'vat', value: 'SE559999123401', current: '' },
  ], ['name', 'not-a-field', '__proto__', 'constructor', 'rcontacts.__proto__.e', 'vat'], 'ra');
  assert.deepEqual(out.applied, ['name', 'vat']);
  assert.equal(out.data.name, 'Fictional Reseller AB');
  assert.equal(out.data.vat, 'SE559999123401');
  assert.equal(out.data['not-a-field'], undefined);
  assert.equal(out.data.polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(importer.applyChecked({ name: 'Keep' }, [{ id: 'name', value: 'Other', current: '' }], ['name'], 'da').data.name, 'Keep');
});

test('the reseller form offers import and distribution does not', function () {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.equal((html.match(/id="import_btn_ra"/g) || []).length, 1);
  assert.equal((html.match(/id="import_btn_rb"/g) || []).length, 1);
  assert.equal(html.indexOf('id="import_btn_da"'), -1);
  assert.equal((html.match(/Import details from the counterparty's contract/g) || []).length, 2);
  assert.match(html, /src="\/agreement-import\.js"/);
  assert.match(html, /function importCounterpartyDetails/);
  assert.match(html, /AgreementImport\.preview/);
  assert.match(html, /AgreementImport\.applyChecked/);
  assert.match(html, /Nothing has been written into the form/);
  const routeAt = server.indexOf("app.post('/api/ai/import-details'");
  const scriptAt = server.indexOf("app.get('/agreement-import.js'");
  const catchAll = server.indexOf("app.get('*'");
  assert.ok(routeAt > 0 && scriptAt > routeAt && catchAll > scriptAt);
  const route = server.slice(routeAt, server.indexOf("app.post('/api/ai/suggest-note'"));
  assert.match(route, /auth\.requireAuth/);
  assert.match(route, /importLimiter/);
  assert.match(route, /documentExtract\.readRequest/);
  assert.match(route, /documentExtract\.sniff/);
  assert.match(route, /documentExtract\.extractText/);
  assert.match(route, /isImportEnabled/);
  assert.match(route, /Agreement import type=/);
  assert.equal(route.indexOf('console.log(extracted'), -1);
  assert.equal(route.indexOf('req.user.email'), -1);
});

function crc32(buf) { return extract.crc32(buf); }

function zipStore(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  files.forEach(function (file) {
    const name = Buffer.from(file.name);
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data);
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
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat(locals.concat([directory, end]));
}

function buildDocx(paragraphs) {
  const body = paragraphs.map(function (paragraph) {
    return '<w:p><w:r><w:t xml:space="preserve">' + String(paragraph).replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</w:t></w:r></w:p>';
  }).join('');
  const document = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
    + body + '</w:body></w:document>';
  const types = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '</Types>';
  const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '</Relationships>';
  return zipStore([
    { name: '[Content_Types].xml', data: types },
    { name: '_rels/.rels', data: rels },
    { name: 'word/document.xml', data: Buffer.from(document, 'utf8') },
  ]);
}

function buildPdf(text) {
  return Buffer.from('%PDF-1.4\n' + text, 'latin1');
}

describe('POST /api/ai/import-details', function () {
  let server;
  let base;
  let token;
  const db = require('../db');
  const auth = require('../auth');
  const logs = [];
  let modelCalls = 0;
  const originalEnabled = ai.enabled;
  const originalComplete = ai.completeStructured;
  const originalLog = console.log;
  const originalError = console.error;
  const originalQuery = db.query;

  before(async function () {
    console.log = function () { logs.push(Array.prototype.join.call(arguments, ' ')); };
    console.error = function () { logs.push(Array.prototype.join.call(arguments, ' ')); };
    token = auth.signToken({ id: 7, email: 'private.seller@example.com', name: 'Private Seller' });
    db.query = async function () { throw new Error('agreement import must not touch the database'); };
    ai.completeStructured = async function (params) {
      modelCalls += 1;
      const prompt = params.messages[0].content;
      assert.equal(prompt.indexOf('maxItems'), -1);
      assert.match(prompt, /Fictional Reseller AB/);
      return {
        stop_reason: 'tool_use',
        content: [{
          type: 'tool_use',
          name: importer.TOOL_NAME,
          input: {
            fields: [
              row('name', 'Fictional Reseller AB', 'The reseller is Fictional Reseller AB.'),
              row('pay', '45', 'Payment terms: 45 days net.'),
              row('vat', 'SE559999123401', 'VAT number SE559999123401.'),
              row('pay', '15', 'Payment is due within 14 days of invoice.'),
            ],
          },
        }],
      };
    };
    const app = require('../server');
    server = await new Promise(function (resolve) {
      const listening = app.listen(0, '127.0.0.1', function () { resolve(listening); });
    });
    base = 'http://127.0.0.1:' + server.address().port;
  });

  after(async function () {
    ai.enabled = originalEnabled;
    ai.completeStructured = originalComplete;
    db.query = originalQuery;
    console.log = originalLog;
    console.error = originalError;
    if (server) await new Promise(function (resolve) { server.close(resolve); });
  });

  function cookieHeader() {
    return auth.COOKIE + '=' + token;
  }

  async function postFile(filename, bytes, fields, cookie) {
    const form = new FormData();
    form.append('file', new File([bytes], filename), filename);
    Object.keys(fields || {}).forEach(function (key) { form.append(key, fields[key]); });
    return fetch(base + '/api/ai/import-details', {
      method: 'POST',
      body: form,
      headers: cookie ? { cookie: cookie } : {},
    });
  }

  test('requires a session', async function () {
    const res = await postFile('contract.docx', buildDocx(['Hello']), { agreementType: 'ra' });
    assert.equal(res.status, 401);
  });

  test('rejects a bad file before calling the model', async function () {
    const before = modelCalls;
    ai.enabled = true;
    const docx = buildDocx(PARAGRAPHS);
    const pdf = buildPdf('not really a pdf');
    const badName = await postFile('notes.txt', pdf, { agreementType: 'ra' }, cookieHeader());
    assert.equal(badName.status, 400);
    const docxNamedPdf = await postFile('contract.docx', pdf, { agreementType: 'ra' }, cookieHeader());
    assert.equal(docxNamedPdf.status, 400);
    assert.match((await docxNamedPdf.json()).error, /Word document/);
    const pdfNamedDocx = await postFile('contract.pdf', docx, { agreementType: 'reseller' }, cookieHeader());
    assert.equal(pdfNamedDocx.status, 400);
    assert.match((await pdfNamedDocx.json()).error, /not a PDF/);
    assert.equal(modelCalls, before);
    logs.forEach(function (line) {
      assert.equal(line.indexOf(SENTINEL), -1);
      assert.equal(line.indexOf('Fictional Reseller AB'), -1);
      assert.equal(line.indexOf('private.seller@example.com'), -1);
    });
  });

  test('reseller only: distribution and a missing type are refused', async function () {
    const before = modelCalls;
    ai.enabled = true;
    const docx = buildDocx(PARAGRAPHS);
    const distribution = await postFile('contract.docx', docx, { agreementType: 'distribution' }, cookieHeader());
    const body = await distribution.json();
    assert.equal(distribution.status, 400);
    assert.match(body.error, /reseller agreements only/);
    const da = await postFile('contract.docx', docx, { agreementType: 'da' }, cookieHeader());
    assert.equal(da.status, 400);
    const missing = await postFile('contract.docx', docx, {}, cookieHeader());
    assert.equal(missing.status, 400);
    assert.match((await missing.json()).error, /agreement type/);
    assert.equal(modelCalls, before);
  });

  test('returns a preview and does not write or log the document', async function () {
    ai.enabled = true;
    const before = modelCalls;
    const res = await postFile('fictional-reseller.docx', buildDocx(PARAGRAPHS), { agreementType: 'ra' }, cookieHeader());
    const body = await res.json();
    assert.equal(res.status, 200, JSON.stringify(body));
    assert.equal(body.type, 'ra');
    assert.equal(byId(body.fields, 'name').value, 'Fictional Reseller AB');
    assert.equal(byId(body.fields, 'pay').value, '45');
    assert.equal(byId(body.fields, 'vat').value, 'SE559999123401');
    assert.equal(body.fields.some(function (field) { return field.value === '15'; }), false);
    assert.equal(JSON.stringify(body).indexOf(SENTINEL), -1);
    assert.equal(body.fields[0].quote.indexOf(SENTINEL), -1);
    assert.equal(modelCalls, before + 1);
    assert.ok(logs.some(function (line) { return line.indexOf('Agreement import type=ra kind=docx fields=') === 0; }));
    logs.forEach(function (line) {
      assert.equal(line.indexOf(SENTINEL), -1);
      assert.equal(line.indexOf('Fictional Reseller AB'), -1);
      assert.equal(line.indexOf('Erika Lind'), -1);
      assert.equal(line.indexOf('private.seller@example.com'), -1);
      assert.equal(line.indexOf('SE559999123401'), -1);
    });
  });

  test('says AI is not configured and does not read the document into the log', async function () {
    ai.enabled = false;
    const before = modelCalls;
    const res = await postFile('fictional-reseller.docx', buildDocx(PARAGRAPHS), { agreementType: 'ra' }, cookieHeader());
    const body = await res.json();
    ai.enabled = true;
    assert.equal(res.status, 503);
    assert.match(body.error, /not configured/i);
    assert.equal(JSON.stringify(body).indexOf(SENTINEL), -1);
    assert.equal(modelCalls, before);
    logs.forEach(function (line) { assert.equal(line.indexOf(SENTINEL), -1); });
  });
});

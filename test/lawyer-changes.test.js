const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const LC = require('../lawyer-changes');
const komplett = require('./fixtures/komplett-16019013');

function clause(id, op, oldText, newText, extra) {
  return Object.assign({
    target: { kind: 'clause', id: id },
    op: op || 'replace',
    oldText: oldText || '',
    newText: newText || '',
    label: id,
    rationale: 'test',
    anchor: '',
  }, extra || {});
}

test('schema accepts clause, annex, and field proposals and normalises aliases', function () {
  const clauseOk = LC.validateProposal(clause('4A', 'insert', '', 'Parent guarantee.', { anchor: 'ra.s4.payment', label: '§4A' }));
  assert.equal(clauseOk.ok, true);
  assert.equal(clauseOk.proposal.target.id, '4A');
  assert.equal(clauseOk.proposal.anchor, 'ra.s4.payment');

  const annexOk = LC.validateProposal({
    target: { kind: 'annex', id: 'appendix 3' },
    op: 'replace',
    oldText: '12 months',
    newText: '24 months from the invoice date',
    label: '',
    rationale: '',
    anchor: '',
  });
  assert.equal(annexOk.ok, true);
  assert.equal(annexOk.proposal.target.id, '3');
  assert.equal(annexOk.proposal.label, 'Annex 3');

  const fieldOk = LC.validateProposal({
    target_kind: 'field',
    target_id: 'payment days',
    op: 'replace',
    old_text: '30',
    new_text: '60',
    label: 'Payment days',
    rationale: 'Cover sheet',
    anchor: '',
  });
  assert.equal(fieldOk.ok, true);
  assert.equal(fieldOk.proposal.target.id, 'pay');
  assert.equal(fieldOk.proposal.newText, '60');

  ['currency', 'shipping', 'reseller name', 'territory', 'effective date', 'signatory'].forEach(function (alias) {
    const v = LC.validateProposal({
      target: { kind: 'field', id: alias }, op: 'replace', oldText: '', newText: 'x', label: '', rationale: '', anchor: '',
    });
    assert.equal(v.ok, true, alias);
    assert.ok(LC.FIELDS[v.proposal.target.id], alias);
  });
});

test('schema rejects a bad target, a delete without old text, and a replace without new text', function () {
  assert.equal(LC.validateProposal({ target: { kind: 'note', id: 'x' }, op: 'replace', newText: 'a' }).ok, false);
  assert.equal(LC.validateProposal({ target: { kind: 'annex', id: '9' }, op: 'replace', newText: 'a' }).ok, false);
  assert.equal(LC.validateProposal({ target: { kind: 'field', id: 'bonus' }, op: 'replace', newText: 'a' }).ok, false);
  assert.equal(LC.validateProposal(clause('ra.s4.payment', 'delete', '   ', '')).ok, false);
  assert.equal(LC.validateProposal(clause('ra.s4.payment', 'replace', 'old', '  ')).ok, false);
  assert.equal(LC.validateProposal(clause('ra.s4.payment', 'insert', '', 'text', { anchor: 'not a clause' })).ok, false);

  const mixed = LC.validateProposals([
    clause('ra.s4.payment', 'replace', 'old', 'new'),
    { target: { kind: 'annex', id: '99' }, op: 'replace', newText: 'nope' },
  ]);
  assert.equal(mixed.ok, false);
  assert.equal(mixed.proposals.length, 1);
  assert.equal(mixed.rejected.length, 1);
});

test('legacy clauseId proposals and the propose_changes tool shape both validate', function () {
  const legacy = LC.validateProposal({ clauseId: 'ra.marketplaces', newText: 'No marketplaces without consent.', rationale: 'Hold the line.' });
  assert.equal(legacy.ok, true);
  assert.deepEqual(legacy.proposal.target, { kind: 'clause', id: 'ra.marketplaces' });
  assert.equal(legacy.proposal.op, 'replace');

  assert.equal(LC.PROPOSE_CHANGES_TOOL.name, 'propose_changes');
  const item = LC.PROPOSE_CHANGES_TOOL.input_schema.properties.changes.items;
  ['target_kind', 'target_id', 'op', 'old_text', 'new_text', 'label', 'rationale', 'anchor'].forEach(function (key) {
    assert.ok(item.required.indexOf(key) >= 0, key);
  });
  assert.deepEqual(item.properties.op.enum, ['replace', 'insert', 'delete']);
  assert.deepEqual(item.properties.target_kind.enum, ['clause', 'annex', 'field']);
});

test('apply writes clauses, a new §4A, annexes, and cover-sheet fields without mutating the input', function () {
  const input = { _type: 'ra', curr: 'EUR', pay: '30', name: '' };
  const result = LC.applyProposals(input, [
    clause('ra.s4.payment', 'replace', 'pay in EUR within 30 days', 'pay in SEK within sixty (60) days'),
    clause('4A', 'insert', '', 'Parent company guarantee.', { anchor: 'ra.s4.payment', label: '§4A' }),
    clause('10.6', 'delete', 'Liquidated damages.', ''),
    { target: { kind: 'annex', id: '3' }, op: 'replace', oldText: '12 months', newText: 'Warranty: 24 months from the invoice date.', label: 'Annex 3', rationale: '', anchor: '' },
    { target: { kind: 'annex', id: '5' }, op: 'insert', oldText: '', newText: 'Own operations only.', label: 'Annex 5', rationale: '', anchor: '' },
    { target: { kind: 'field', id: 'curr' }, op: 'replace', oldText: 'EUR', newText: 'SEK', label: 'Currency', rationale: '', anchor: '' },
    { target: { kind: 'field', id: 'pay' }, op: 'replace', oldText: '30', newText: '60', label: 'Payment days', rationale: '', anchor: '' },
    { target: { kind: 'field', id: 'name' }, op: 'replace', oldText: '', newText: 'KOMPLETT', label: 'Reseller', rationale: '', anchor: '' },
    { nope: true },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.rejected.length, 1);
  assert.equal(input.curr, 'EUR');
  assert.equal(input.clauseOverrides, undefined);
  assert.equal(result.data.curr, 'SEK');
  assert.equal(result.data.pay, '60');
  assert.equal(result.data.name, 'KOMPLETT');
  assert.match(result.data.clauseOverrides['ra.s4.payment'], /SEK/);
  assert.equal(result.data.clauseInserts[0].id, '4A');
  assert.equal(result.data.clauseInserts[0].anchor, 'ra.s4.payment');
  assert.ok(result.data.clauseDeletes.indexOf('10.6') >= 0);
  assert.match(result.data.annexOverrides['3'], /24 months/);
  assert.match(result.data.annexOverrides['5'], /Own operations/);
  assert.equal(result.data.redlines.length, result.applied.length);
});

test('the Komplett 2026-10-12 checklist validates and applies in full', function () {
  const numbers = {};
  komplett.proposals.forEach(function (item) {
    if (item.checklistNr != null) numbers[item.checklistNr] = true;
  });
  for (let n = 1; n <= 21; n++) assert.ok(numbers[n], 'checklist row ' + n);

  const checked = LC.validateProposals(komplett.proposals);
  assert.equal(checked.rejected.length, 0, JSON.stringify(checked.rejected));
  const result = LC.applyProposals(komplett.baseAgreement(), komplett.proposals);
  assert.equal(result.rejected.length, 0);
  const data = result.data;
  assert.equal(data._ref, 'oneflow-16019013');
  assert.equal(data.name, 'KOMPLETT');
  assert.equal(data.curr, 'EUR');
  assert.equal(data.pay, '30');
  assert.equal(data.inco, 'DAP');
  assert.equal(data.date, '2026-10-01');
  assert.equal(data.sig_name, 'KOMPLETT authorised signatory');
  assert.equal(data.sig_name.indexOf('Höynälä'), -1);
  assert.match(data.terr, /Iceland/);
  assert.match(data.terr, /Faroe/);
  assert.equal(data.clauseInserts.some(function (c) { return c.id === '4A'; }), true);
  assert.match(data.annexOverrides['3'], /24\) months from the invoice date/);
  assert.match(data.annexOverrides['1A'], /EUR/);
  assert.match(data.annexOverrides['1B'], /points of sale/);
  assert.match(data.annexOverrides['4'], /DAP/);
  assert.match(data.annexOverrides['5'], /own operations/i);
  assert.ok(data.clauseDeletes.indexOf('10.6') >= 0);
  assert.ok(data.clauseDeletes.indexOf('20.3') >= 0);
  assert.match(data.clauseOverrides['ra.s4.payment'], /EUR/);
  assert.match(data.clauseOverrides['ra.s4.payment'], /thirty \(30\) days/);
  assert.equal(result.conflicts.length, 0, JSON.stringify(result.conflicts));

  const body = LC.pendingBody(data, ['ra.s4.payment', 'ra.marketplaces']);
  assert.equal(body.some(function (c) { return c.id === '4A'; }), true);
  const annexes = LC.pendingAnnexes(data, ['3']);
  assert.equal(annexes.some(function (a) { return a.id === '4'; }), true);
  assert.equal(annexes.some(function (a) { return a.id === '5'; }), true);
  assert.equal(annexes.some(function (a) { return a.id === '3'; }), false);
});

test('consistency flags 24-month warranty against annex 3, and SEK/60 against §4', function () {
  const warranty = LC.applyProposals({ _type: 'ra', curr: 'EUR', pay: '30' }, [
    clause('ra.warranty_asis', 'replace', 'as is', 'The warranty period is twentyfour (24) months from the invoice date.'),
  ]);
  assert.equal(warranty.conflicts.length, 1);
  assert.equal(warranty.conflicts[0].code, 'warranty_months');
  assert.match(warranty.conflicts[0].message, /24/);
  assert.match(warranty.conflicts[0].message, /12/);

  const aligned = LC.applyProposals(warranty.data, [
    { target: { kind: 'annex', id: '3' }, op: 'replace', oldText: '12 months', newText: 'Warranty: twentyfour (24) months from the invoice date.', label: 'Annex 3', rationale: '', anchor: '' },
  ]);
  assert.equal(aligned.conflicts.filter(function (c) { return c.code === 'warranty_months'; }).length, 0);

  const capOnly = LC.applyProposals({ _type: 'ra' }, [
    clause('ra.s10.cap', 'replace', 'cap', 'The aggregate liability shall not exceed the purchases during the preceding twelve (12) months.'),
  ]);
  assert.equal(capOnly.conflicts.filter(function (c) { return c.code === 'warranty_months'; }).length, 0);

  const payment = LC.applyProposals({ _type: 'ra', curr: 'EUR', pay: '30' }, [
    { target: { kind: 'field', id: 'curr' }, op: 'replace', oldText: 'EUR', newText: 'SEK', label: '', rationale: '', anchor: '' },
    { target: { kind: 'field', id: 'pay' }, op: 'replace', oldText: '30', newText: '60', label: '', rationale: '', anchor: '' },
    clause('ra.s4.payment', 'replace', 'EUR 30', 'The Reseller shall pay by bank transfer in EUR, within thirty (30) days from the invoice date. Orders are confirmed within two (2) business days.'),
  ]);
  const paymentIssues = payment.conflicts.filter(function (c) { return c.code === 'payment_terms'; });
  assert.ok(paymentIssues.length >= 1);
  assert.match(paymentIssues[0].message, /SEK/);
  assert.match(paymentIssues[0].message, /60/);

  const coverOnly = LC.applyProposals({ _type: 'ra', curr: 'EUR', pay: '30' }, [
    { target: { kind: 'field', id: 'curr' }, op: 'replace', oldText: 'EUR', newText: 'SEK', label: '', rationale: '', anchor: '' },
    { target: { kind: 'field', id: 'pay' }, op: 'replace', oldText: '30', newText: '60', label: '', rationale: '', anchor: '' },
  ]);
  assert.equal(coverOnly.conflicts.filter(function (c) { return c.code === 'payment_terms'; }).length, 0);
  assert.match(LC.resolvedClauseText(coverOnly.data, 'ra.s4.payment'), /SEK/);
  assert.match(LC.resolvedClauseText(coverOnly.data, 'ra.s4.payment'), /60/);
});

test('tracked docx contains w:ins, w:del, and w:trackRevisions for an applied redline', function () {
  const result = LC.applyProposals(komplett.baseAgreement(), komplett.proposals);
  const buf = LC.buildTrackedDocx(LC.docxParagraphsFromData(result.data), { date: '2026-10-12T00:00:00Z' });
  assert.equal(buf.slice(0, 2).toString('binary'), 'PK');
  const xml = buf.toString('utf8');
  assert.match(xml, /<w:ins /);
  assert.match(xml, /<w:del /);
  assert.match(xml, /<w:delText[\s>]/);
  assert.match(xml, /<w:trackRevisions\/>/);
  assert.match(xml, /twentyfour \(24\) months/);
  assert.match(xml, /KOMPLETT authorised signatory/);
  assert.match(xml, /Parent-company guarantee|guarantees payment/);
  const segs = LC.redlineSegments('within 30 days', 'within sixty (60) days');
  assert.ok(segs.some(function (s) { return s.type === 'del' && s.text.indexOf('30') >= 0; }));
  assert.ok(segs.some(function (s) { return s.type === 'ins' && s.text.indexOf('sixty') >= 0; }));
});

test('prompt catalog tells the model to propose structured edits for every target', function () {
  const block = LC.catalogBlock('ra', komplett.baseAgreement(), []);
  assert.match(block, /propose_changes/);
  assert.match(block, /paste/);
  assert.match(block, /\[ra\.s4\.payment\]/);
  assert.match(block, /\[curr\]/);
  assert.match(block, /\[annex 3\]/);
  assert.match(block, /\[annex 4\]/);
  assert.match(block, /4A/);
});

describe('GET /lawyer-changes.js', function () {
  let server;
  let base;

  before(async function () {
    const app = require('../server');
    server = await new Promise(function (resolve) {
      const s = app.listen(0, '127.0.0.1', function () { resolve(s); });
    });
    base = 'http://127.0.0.1:' + server.address().port;
  });

  after(async function () {
    if (server) await new Promise(function (resolve) { server.close(resolve); });
  });

  test('is served as script before the HTML catch-all', async function () {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const route = src.indexOf("app.get('/lawyer-changes.js'");
    const catchAll = src.indexOf("app.get('*'");
    assert.ok(route > 0);
    assert.ok(catchAll > route);
    const res = await fetch(base + '/lawyer-changes.js');
    const body = await res.text();
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /javascript/);
    assert.match(res.headers.get('cache-control'), /no-store/);
    assert.equal(body.indexOf('<!DOCTYPE'), -1);
    assert.match(body, /LawyerChanges/);
    assert.match(body, /propose_changes/);
  });
});

test('the agreement page loads the helper and exposes approve controls', function () {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(html, /src="\/lawyer-changes\.js"/);
  assert.match(html, /Approve all/);
  assert.match(html, /_trackChanges/);
  assert.match(html, /InsertedTextRun/);
  assert.match(html, /DeletedTextRun/);
  const ai = fs.readFileSync(path.join(__dirname, '..', 'ai.js'), 'utf8');
  assert.match(ai, /propose_changes/);
  assert.equal(ai.indexOf("name: 'propose_clause_change'"), -1);
});

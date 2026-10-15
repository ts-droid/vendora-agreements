const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const ai = require('../ai');
const LC = require('../lawyer-changes');

function clause(id, op, oldText, newText, extra) {
  return Object.assign({
    target: { kind: 'clause', id: id },
    op: op,
    oldText: oldText || '',
    newText: newText || '',
    label: id,
    rationale: 'test',
    anchor: '',
  }, extra || {});
}

test('a review with no type is refused and does not load either playbook', function () {
  assert.throws(function () { ai.reviewMaterial(''); }, function (err) {
    return err.status === 400 && err.code === 'type_required';
  });
  assert.throws(function () { ai.reviewContextText({}); }, function (err) {
    return err.code === 'type_required';
  });
  const empty = LC.catalogBlock('', { delplace: LC.DA_DELIVERY_POSITION }, [
    { id: 'da.s5.payment', text: LC.DA_DELIVERY_POSITION },
  ]);
  assert.match(empty, /Choose the agreement type/);
  assert.equal(empty.indexOf(LC.DA_DELIVERY_POSITION), -1);
  assert.equal(empty.indexOf(LC.RA_DELIVERY_POSITION), -1);
  assert.deepEqual(LC.catalog(''), []);
});

test('a reseller review never receives distribution-only positions, including the Lomma delivery address', function () {
  const daAgreement = {
    _type: 'da',
    name: 'Supplier',
    inco: 'DDP',
    delplace: 'Vendora Nordic AB, Ladugårdsvägen 1, 234 35 Lomma',
    incoplace: LC.DA_DELIVERY_POSITION,
  };
  const playbook = {
    guidance: 'Always use ' + LC.DA_DELIVERY_POSITION + '.\n\nSwedish law stays.',
    notes: [
      { topic: 'Delivery', content: LC.DA_DELIVERY_POSITION, agreement_type: 'da' },
      { topic: 'Law', content: 'Swedish law stays.', agreement_type: 'ra' },
    ],
  };
  ['ra', 'rb'].forEach(function (type) {
    const text = ai.reviewContextText({
      type: type,
      agreement: daAgreement,
      clauses: [{ id: 'da.s5.payment', label: 'Payment', text: LC.DA_DELIVERY_POSITION }],
      playbook: playbook,
    });
    assert.equal(text.indexOf(LC.DA_DELIVERY_POSITION), -1, type);
    assert.equal(text.indexOf('da.s5.payment'), -1, type);
    assert.equal(text.indexOf('da.delivery'), -1, type);
    assert.ok(text.indexOf(LC.RA_DELIVERY_POSITION) >= 0, type);
  });
  const reseller = ai.reviewMaterial('ra');
  assert.ok(reseller.indexOf('not a commercial agent') >= 0);
  assert.ok(reseller.indexOf('ra.s13b.no_compensation') >= 0);
  assert.ok(reseller.indexOf('ra.s13c.after_end') >= 0);
  assert.equal(reseller.indexOf(LC.DA_DELIVERY_POSITION), -1);

  const suggested = LC.validateProposal(
    clause('4A', 'insert', '', 'Deliver ' + LC.DA_DELIVERY_POSITION + '.', { anchor: 'ra.s4.payment', label: 'Delivery' }),
    { _type: 'ra' }
  );
  assert.equal(suggested.ok, false);
  assert.match(suggested.errors.join(' '), /different agreement type/);
  assert.equal(LC.validateProposal(clause('da.s5.payment', 'replace', 'within 60 days', 'within 30 days'), { _type: 'ra' }).ok, false);
  assert.equal(ai.benchmarkFits('ra', 'RESELLER AGREEMENT\n' + LC.DA_DELIVERY_POSITION), false);
  assert.throws(function () {
    ai.reviewContextText({ type: 'ra', ourText: 'DISTRIBUTOR AGREEMENT\n' + LC.DA_DELIVERY_POSITION });
  }, function (err) { return err.code === 'type_mismatch'; });
});

test('a distribution review never receives reseller-only positions', function () {
  const text = ai.reviewContextText({
    type: 'da',
    agreement: { _type: 'ra', name: 'Komplett', inco: 'EXW', incoplace: 'Vendora Nordic AB, Lomma, Sweden' },
    clauses: [{ id: 'ra.s13b.no_compensation', label: '§13B', text: 'The Reseller is a reseller and not a commercial agent.' }],
    playbook: {
      guidance: 'Reseller collects ' + LC.RA_DELIVERY_POSITION + '.\n\nPrice protection stays.',
      notes: [{ topic: 'Agent', content: 'The reseller is not a commercial agent.', agreement_type: 'ra' }],
    },
  });
  assert.equal(text.indexOf(LC.RA_DELIVERY_POSITION), -1);
  assert.equal(text.indexOf('not a commercial agent'), -1);
  assert.equal(text.indexOf('ra.s13b'), -1);
  assert.equal(text.indexOf('ra.s13c'), -1);
  assert.ok(text.indexOf(LC.DA_DELIVERY_POSITION) >= 0);
  assert.equal(text.indexOf('Ladugårdsvägen 1, 234 35 Lomma') >= 0, true);

  const material = ai.reviewMaterial('da');
  assert.equal(material.indexOf(LC.RA_DELIVERY_POSITION), -1);
  assert.equal(material.indexOf('not a commercial agent'), -1);
  assert.ok(material.indexOf(LC.DA_DELIVERY_POSITION) >= 0);

  const suggested = LC.validateProposal(
    clause('5A', 'insert', '', LC.RA_DELIVERY_POSITION, { anchor: 'da.s5.payment' }),
    { _type: 'da' }
  );
  assert.equal(suggested.ok, false);
  assert.equal(LC.validateProposal(
    clause('ra.s13b.no_compensation', 'replace', 'old', 'The Reseller is a reseller and not a commercial agent.'),
    { _type: 'da' }
  ).ok, false);
  assert.throws(function () {
    ai.reviewContextText({
      type: 'da',
      ourText: 'RESELLER AGREEMENT\n' + LC.RA_DELIVERY_POSITION + '\n' + 'term '.repeat(40),
    });
  }, function (err) { return err.code === 'type_mismatch'; });
});

test('the review, chat, and save routes require an explicit type and do not guess one', function () {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  assert.match(server, /Choose the agreement type before reviewing/);
  assert.match(server, /Choose the agreement type before asking the lawyer/);
  assert.match(server, /Choose the agreement type before checking a document/);
  assert.match(server, /alignAgreementType\(data, type\)/);
  assert.match(server, /alignAgreementType\(data, row\.type\)/);
  const inviteAt = server.indexOf("app.post('/api/invites'");
  const invite = server.slice(inviteAt, inviteAt + 1600);
  assert.match(invite, /\[aligned\.type,/);
  assert.match(html, /Agreement type \*/);
  assert.match(html, /function familyFromSelect/);
  assert.match(html, /Choose the agreement type first/);
  assert.equal(ai.normalizeAgreementType(''), null);
  assert.equal(ai.normalizeAgreementType('reseller'), 'ra');
  assert.equal(ai.normalizeAgreementType('distribution'), 'da');
  assert.equal(ai.familyOf('rb'), 'reseller');
  assert.equal(ai.sameFamily('ra', 'rb'), true);
  assert.equal(ai.sameFamily('ra', 'da'), false);
});

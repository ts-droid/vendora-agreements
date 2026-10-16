'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../workflow-core');
const seeds = require('./fixtures/workflow-seeds.json');

const POINT_OF_SALE = 'Minst ett försäljningsställe krävs.';
function draft() {
  const data = { ...core.copy(seeds.ra), pos_web: [], pos_physical: [] };
  return { id: 1, type: 'ra', status: 'draft', data,
    workflow_revision: 1, workflow_state: core.createState(data) };
}

test('reseller final approval remains blocked until customer supplies a point of sale', () => {
  assert.ok(core.signatureProblems(draft()).includes(POINT_OF_SALE));
});

test('a customer website satisfies the point-of-sale requirement', () => {
  const row = draft();
  row.data.pos_web = ['customer.example.test'];
  assert.deepEqual(core.signatureProblems(row), []);
});

test('a physical store satisfies the same point-of-sale requirement', () => {
  const row = draft();
  row.data.pos_physical = ['Testgatan 2, Strängnäs'];
  assert.deepEqual(core.signatureProblems(row), []);
});

test('completing points of sale does not bypass other mandatory signature fields', () => {
  const row = draft();
  row.data.pos_web = ['customer.example.test'];
  row.data.sig_email = '';
  const problems = core.signatureProblems(row);
  assert.ok(problems.includes('Saknad uppgift: sig_email'));
  assert.ok(!problems.includes(POINT_OF_SALE));
});

test('public customer completion persists points of sale without accepting proposed terms', () => {
  const row = draft();
  row.status = 'invited';
  row.workflow_state.sent = { version: 2, data: core.publicData(row.data) };
  const submitted = core.receive(row, {
    pos_web: ['customer.example.test'], pos_physical: [],
    _proposals: { pay: { original: 'forged', proposed: '60', comment: 'Please extend' } }
  }, 2, 'customer', '2026-10-16T00:00:00Z');
  assert.deepEqual(submitted.data.pos_web, ['customer.example.test']);
  assert.equal(submitted.data.pay, row.data.pay);
  assert.equal(submitted.data._proposals.pay.original, row.data.pay);
  const after = { ...row, data: submitted.data, workflow_state: submitted.state, status: 'submitted' };
  assert.ok(!core.signatureProblems(after).includes(POINT_OF_SALE));
  assert.ok(core.signatureProblems(after).some(p => p.includes('ändringsförslag')));
});

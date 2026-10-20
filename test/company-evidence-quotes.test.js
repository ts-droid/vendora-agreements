'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const D = require('../counterparty-details');
const C = require('../workflow-core');
const cases = require('../eval/company-accuracy/cases.cjs');
const {grade} = require('../eval/company-accuracy/score.cjs');
const seeds = require('./fixtures/workflow-seeds.json');
const item = cases.find(c => c.id === '08-contact-is-not-signatory');
const doc = {kind:'text', data:item.source, filename:item.id + '.txt'};
const contactLine = item.source.split('\n').find(line => line.startsWith('Main customer contact:'));
const copy = value => JSON.parse(JSON.stringify(value));

// Replay of company_details supplied from the user's live synthetic benchmark run.
// This is a fixed regression response, NOT a new provider call or an accuracy score.
const recorded = {
  party_name:'Demo Shop Test AB', role:'customer', ambiguous:false,
  party_evidence:'Vendora Nordic AB is the seller. Demo Shop Test AB is the sole customer, incorporated in Sweden; registration TEST-SE-008.',
  source_ref:'Opening paragraph (no page/section numbering)',
  note:'Demo Shop Test AB is the only named customer. Robin Exempel is expressly an operational contact and not a signatory, so no sig_* fields are proposed; the signatory is not yet nominated. No registered address or VAT number is stated. The name differs from the current form value (Benchmark Decoy Test Company), so confirm the correct legal entity before import.',
  fields:[
    {field:'name', value:'Demo Shop Test AB', evidence:'Demo Shop Test AB is the sole customer', source_ref:'Opening paragraph', confidence:'high'},
    {field:'reg', value:'TEST-SE-008', evidence:'Demo Shop Test AB is the sole customer, incorporated in Sweden; registration TEST-SE-008.', source_ref:'Opening paragraph', confidence:'high'},
    {field:'country', value:'Sweden', evidence:'Demo Shop Test AB is the sole customer, incorporated in Sweden', source_ref:'Opening paragraph', confidence:'high'},
    {field:'rcontacts.main.n', value:'Robin Exempel', evidence:'Main customer contact: Robin Exempel', source_ref:'Contact paragraph', confidence:'high'},
    {field:'rcontacts.main.e', value:'robin@demoshop.example', evidence:'Main customer contact: Robin Exempel; email robin@demoshop.example', source_ref:'Contact paragraph', confidence:'high'},
    {field:'rcontacts.main.p', value:'+46 00 000 00 08', evidence:'Main customer contact: Robin Exempel; ... telephone +46 00 000 00 08.', source_ref:'Contact paragraph', confidence:'high'},
    {field:'rcontacts.fin.e', value:'accounts@demoshop.example', evidence:'Finance contact email: accounts@demoshop.example.', source_ref:'Contact paragraph', confidence:'high'}
  ]
};
const phone = raw => raw.fields.find(field => field.field === 'rcontacts.main.p');

function correctedReplay() {
  const raw = copy(recorded);
  // Change the quotation in this TEST RESPONSE only. Production never rewrites evidence.
  phone(raw).evidence = contactLine;
  return raw;
}

test('recorded live case 08: all seven values are correct but the abbreviated phone quote is rejected', () => {
  assert.equal(crypto.createHash('sha256').update(item.source).digest('hex'),
    '8c059166abf53155695c3db28c51144dec5f564bfd16875ac70b6e195830a24c');
  const before = copy(recorded);
  const g = grade(item, recorded);
  assert.equal(g.partyCorrect, true);
  assert.equal(g.raw.tp, 7); assert.equal(g.raw.fp, 0); assert.equal(g.raw.fn, 0);
  assert.equal(g.raw.supportedQuotes, 6);
  assert.equal(g.afterGuard.tp, 6); assert.equal(g.afterGuard.fp, 0);
  assert.deepEqual(g.afterGuard.missing, ['rcontacts.main.p']);
  assert.deepEqual(g.critical, ['unsupported_quote:rcontacts.main.p']);
  assert.equal(g.passed, false);
  const prepared = D.prepare(recorded, 'ra', doc);
  assert.equal(prepared.issue, '');
  assert.deepEqual(prepared.fields.filter(f => f.issue).map(f => f.field), ['rcontacts.main.p']);
  assert.equal(prepared.fields.some(f => f.field.startsWith('sig_')), false);
  assert.deepEqual(recorded, before, 'a rejected quotation must not be silently repaired');
});

test('replaying the full original contact line changes no values and preserves all seven importable fields', () => {
  const raw = correctedReplay();
  assert.deepEqual(raw.fields.map(({field,value}) => ({field,value})),
    recorded.fields.map(({field,value}) => ({field,value})));
  const g = grade(item, raw);
  assert.equal(g.passed, true); assert.equal(g.raw.supportedQuotes, 7);
  assert.equal(g.afterGuard.tp, 7); assert.equal(g.afterGuard.fn, 0);
  assert.equal(g.afterGuard.unsafeCandidate, false);
  assert.deepEqual(g.critical, []);
  assert.ok(D.prepare(raw, 'ra', doc).fields.every(f => !f.issue));
});

for (const marker of ['…', '[...]']) {
  test('inserted omission marker ' + marker + ' is not treated as a source wildcard', () => {
    const raw = correctedReplay();
    phone(raw).evidence = 'Main customer contact: Robin Exempel; ' + marker + ' telephone +46 00 000 00 08.';
    const g = grade(item, raw);
    assert.equal(g.raw.tp, 7);
    assert.equal(g.passed, false);
    assert.ok(g.critical.includes('unsupported_quote:rcontacts.main.p'));
    assert.ok(D.prepare(raw, 'ra', doc).fields.find(f => f.field === 'rcontacts.main.p').issue);
  });
}

test('the same contiguous-evidence requirement applies to party identification', () => {
  const raw = correctedReplay();
  raw.party_evidence = 'Vendora Nordic AB is the seller. ... Demo Shop Test AB is the sole customer';
  const g = grade(item, raw);
  assert.equal(g.partyCorrect, true);
  assert.equal(g.passed, false);
  assert.ok(g.critical.includes('unsupported_party_quote'));
  assert.ok(D.prepare(raw, 'ra', doc).issue);
  assert.equal(g.afterGuard.importableCount, 0);
});

test('literal source ellipses are allowed; validation is still exact source matching, not a blanket ban', () => {
  for (const marker of ['...', '…', '[...]']) {
    const sourceLine = contactLine.replace('; email', '; ' + marker + ' email');
    const literalItem = {...item, source:item.source.replace(contactLine, sourceLine)};
    const raw = correctedReplay();
    phone(raw).evidence = sourceLine;
    raw.fields.find(f => f.field === 'rcontacts.main.e').evidence = sourceLine;
    assert.equal(grade(literalItem, raw).passed, true, marker);
    assert.ok(D.prepare(raw, 'ra', {...doc, data:literalItem.source}).fields.every(f => !f.issue));
  }
});

test('approval cannot bypass a rejected quote, while other grounded values remain selectable', () => {
  const data = C.copy(seeds.ra);
  const state = C.createState(data);
  state.companyImports = [D.snapshot(data, 808, D.prepare(recorded, 'ra', doc))];
  const row = {id:808, type:'ra', data, status:'draft', workflow_revision:3, workflow_state:state};
  const before = C.copy(row);
  const cmd = {action:'apply', importId:'company:808', confirmedParty:true,
    expectedRevision:3, requestId:'quote-regression-808', fields:['rcontacts.main.p']};
  assert.throws(() => C.decideCompanyDetails(row, cmd, 'Regression test', '2026-10-20'), e => e.status === 400);
  assert.deepEqual(row, before);
  const result = C.decideCompanyDetails(row, {...cmd, fields:['rcontacts.main.n','rcontacts.main.e']}, 'Regression test', '2026-10-20');
  assert.equal(D.read(result.data, 'rcontacts.main.n'), 'Robin Exempel');
  assert.equal(D.read(result.data, 'rcontacts.main.e'), 'robin@demoshop.example');
  assert.equal(D.read(result.data, 'rcontacts.main.p'), D.read(data, 'rcontacts.main.p'));
  assert.equal(D.read(result.data, 'sig_name'), D.read(data, 'sig_name'));
});

test('real review request carries contiguous-copy rules in prompt and evidence schemas without answer leakage', async () => {
  const calls = [];
  class MockAnthropic {
    constructor() {
      this.messages = {stream:params => {
        calls.push(params);
        return {finalMessage:async () => ({stop_reason:'end_turn', content:[{
          type:'text', text:JSON.stringify({company_details:recorded,findings:[],questions_for_seller:[]})
        }]})};
      }};
    }
  }
  const file = path.resolve(__dirname, '../ai.js');
  const moduleObject = {exports:{}};
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    require:name => name === '@anthropic-ai/sdk' ? MockAnthropic : require(path.resolve(path.dirname(file), name)),
    module:moduleObject, exports:moduleObject.exports,
    process:{env:{ANTHROPIC_API_KEY:'test-only',AI_FALLBACKS:'0'}}, console, Buffer
  });
  const out = await moduleObject.exports.reviewContract({type:'ra',agreement:seeds.ra,ourText:C.benchmark(seeds.ra),doc});
  assert.equal(calls.length, 1, 'no extra provider calls or automatic repairs');
  assert.deepEqual(JSON.parse(JSON.stringify(out.company_details)), recorded);
  const prompt = calls[0].system.map(block => block.text).join('\n');
  assert.match(prompt, /EVIDENCE MUST BE A CONTIGUOUS COPY/);
  assert.match(prompt, /Copy all intervening text/);
  assert.match(prompt, /not only contact details/);
  const schema = calls[0].output_config.format.schema.properties.company_details;
  for (const description of [schema.properties.party_evidence.description,
    schema.properties.fields.items.properties.evidence.description]) {
    assert.match(description, /contiguous verbatim passage/);
    assert.match(description, /Never insert ellipses/);
    assert.match(description, /owner|whose detail/);
  }
  for (const value of Object.values(item.expected.fields)) {
    // 'Sweden' is already a legitimate part of the house playbook, not a leaked answer.
    if (value === 'Sweden') continue;
    assert.equal(D.PROMPT.includes(value), false, 'No benchmark-specific answers in production prompt: ' + value);
  }
  assert.equal(grade(item, out.company_details).passed, false,
    'changing the instructions must not make the old bad response pass');
});

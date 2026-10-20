'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inspect, childEnvironment, main } = require('../scripts/run-ai-accuracy.cjs');
const ready = () => ({status: 'ready', keyConfigured: true, providerCalls: 0, accuracy: null});
function harness() {
  const logs = [], calls = [];
  return { logs, calls, deps: { inspect: ready, log: text => logs.push(text),
    createOutput: () => '/tmp/synthetic-eval-output',
    spawnSync: (...args) => { calls.push(args); return {status: 0}; } } };
}
test('Railway evaluation defaults to no-cost preflight, even with inherited live opt-in', () => {
  const h = harness();
  assert.equal(main([], {AI_EVAL_ALLOW_LIVE: '1', ANTHROPIC_API_KEY: 'synthetic-key'}, h.deps), 0);
  assert.equal(h.calls.length, 0); assert.ok(!h.logs.join().includes('synthetic-key'));
});
test('Railway child receives AI settings but not database, mail, token or preload credentials', () => {
  const env = {ANTHROPIC_API_KEY: 'synthetic-key', ANTHROPIC_MODEL: 'test-model',
    RAILWAY_GIT_COMMIT_SHA: 'a'.repeat(40), DATABASE_URL: 'do-not-inherit', SMTP_PASS: 'do-not-inherit',
    GOOGLE_SERVICE_ACCOUNT_JSON: 'do-not-inherit', RAILWAY_TOKEN: 'do-not-inherit',
    NODE_OPTIONS: '--require production-bootstrap', AI_EVAL_REPEATS: '3'};
  const next = childEnvironment(env, '/tmp/result', 'smoke');
  assert.equal(next.ANTHROPIC_API_KEY, env.ANTHROPIC_API_KEY); assert.equal(next.ANTHROPIC_MODEL, env.ANTHROPIC_MODEL);
  assert.equal(next.RAILWAY_GIT_COMMIT_SHA, env.RAILWAY_GIT_COMMIT_SHA);
  for (const key of ['DATABASE_URL','SMTP_PASS','GOOGLE_SERVICE_ACCOUNT_JSON','RAILWAY_TOKEN','NODE_OPTIONS']) assert.equal(next[key], undefined);
  assert.equal(next.AI_EVAL_REPEATS, '1'); assert.equal(next.AI_FALLBACKS, '0');
  assert.equal(env.AI_EVAL_REPEATS, '3');
});
test('Railway smoke command runs the real harness explicitly with existing AI configuration', () => {
  const h = harness();
  assert.equal(main(['--smoke'], {ANTHROPIC_API_KEY: 'synthetic-key'}, h.deps), 0);
  assert.equal(h.calls.length, 1);
  const [exe, args, options] = h.calls[0];
  assert.equal(exe, process.execPath); assert.match(args[0], /eval\/company-accuracy\/run\.cjs$/);
  assert.equal(options.env.AI_EVAL_SUITE, 'smoke'); assert.equal(options.env.AI_EVAL_ALLOW_LIVE, '1');
  assert.equal(options.env.AI_EVAL_OUTPUT, '/tmp/synthetic-eval-output');
  assert.ok(!h.logs.join().includes('synthetic-key'));
});
test('Railway missing credentials or missing payload cannot become a passing live test', () => {
  const h = harness(); h.deps.inspect = () => ({status: 'blocked_missing_credential', accuracy: null});
  assert.equal(main(['--smoke'], {}, h.deps), 2); assert.equal(h.calls.length, 0);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-missing-'));
  try { const r = inspect({ANTHROPIC_API_KEY: 'synthetic-key'}, empty); assert.equal(r.status, 'blocked_missing_files'); assert.ok(r.missingFiles.length > 0); assert.ok(!JSON.stringify(r).includes('synthetic-key')); }
  finally { fs.rmSync(empty, {recursive: true, force: true}); }
});
test('Railway forwards failed accuracy results and treats timeout as failure', () => {
  const h = harness(); h.deps.spawnSync = () => ({status: 1});
  assert.equal(main(['--smoke'], {}, h.deps), 1);
  h.deps.spawnSync = () => ({status: null, signal: 'SIGKILL'});
  assert.equal(main(['--smoke'], {}, h.deps), 1);
});
test('Railway all-cases mode requires an explicit command; unknown options do not run anything', () => {
  const h = harness(); assert.equal(main(['--all'], {}, h.deps), 0);
  assert.equal(h.calls[0][2].env.AI_EVAL_SUITE, 'all');
  h.calls.length = 0; assert.equal(main(['--smkoe'], {}, h.deps), 2); assert.equal(h.calls.length, 0);
  assert.equal(main(['--smoke', '--all'], {}, h.deps), 2); assert.equal(h.calls.length, 0);
});

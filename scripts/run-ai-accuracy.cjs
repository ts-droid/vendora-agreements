#!/usr/bin/env node
'use strict';
// Explicit one-off command. Never imported by server.js or invoked at application startup.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const FILES = ['eval/company-accuracy/run.cjs', 'eval/company-accuracy/cases.cjs',
  'eval/company-accuracy/score.cjs', 'ai.js', 'counterparty-details.js',
  'workflow-core.js', 'test/fixtures/workflow-seeds.json'];
const ENV_KEYS = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_MODEL', 'ANTHROPIC_BASE_URL',
  'RAILWAY_GIT_COMMIT_SHA'];
function inspect(env = process.env, root = ROOT) {
  const missingFiles = FILES.filter(file => !fs.existsSync(path.join(root, file)));
  const keyConfigured = Boolean(String(env.ANTHROPIC_API_KEY || '').trim());
  return { status: missingFiles.length ? 'blocked_missing_files' : keyConfigured ? 'ready' : 'blocked_missing_credential',
    keyConfigured, modelConfigured: Boolean(env.ANTHROPIC_MODEL), missingFiles,
    providerCalls: 0, accuracy: null };
}
function childEnvironment(env, output, suite) {
  if (!['smoke', 'all'].includes(suite)) throw new Error('Invalid evaluation suite');
  const result = {};
  // Do not pass database, mail, webhook, Railway tokens or NODE_OPTIONS/preload secrets.
  for (const key of ENV_KEYS) if (typeof env[key] === 'string') result[key] = env[key];
  return Object.assign(result, { NODE_ENV: 'production', AI_FALLBACKS: '0',
    AI_EVAL_ALLOW_LIVE: '1', AI_EVAL_SUITE: suite, AI_EVAL_REPEATS: '1', AI_EVAL_OUTPUT: output });
}
function main(args = process.argv.slice(2), env = process.env, deps = {}) {
  const log = deps.log || console.log;
  const mode = args[0] || '--check';
  if (args.length > 1 || !['--check', '--smoke', '--all'].includes(mode)) {
    log('Usage: run-ai-accuracy.cjs --check | --smoke | --all'); return 2;
  }
  const check = (deps.inspect || inspect)(env);
  // Prints presence booleans only; never credentials or other environment values.
  log(JSON.stringify(check));
  if (check.status !== 'ready') return 2;
  if (mode === '--check') return 0;
  const createOutput = deps.createOutput || (() => fs.mkdtempSync(path.join(os.tmpdir(), 'vendora-ai-eval-')));
  const output = createOutput();
  log('Live evaluation requested: ' + (mode === '--smoke' ? 3 : 12) + ' review calls. Provider charges apply.');
  log('Result file: ' + path.join(output, 'results.json'));
  const run = deps.spawnSync || spawnSync;
  const result = run(process.execPath, [path.join(ROOT, 'eval/company-accuracy/run.cjs')], {
    cwd: ROOT, env: childEnvironment(env, output, mode.slice(2) === 'smoke' ? 'smoke' : 'all'),
    stdio: 'inherit', timeout: 25 * 60 * 1000, killSignal: 'SIGKILL'
  });
  if (result.error || result.signal || !Number.isInteger(result.status)) {
    log('Evaluation interrupted or could not start. No completed accuracy result is available.');
    return 1;
  }
  return result.status;
}
module.exports = { inspect, childEnvironment, main };
if (require.main === module) {
  try { process.exitCode = main(); }
  catch (_) { console.error('Evaluation setup failed. No live accuracy claim.'); process.exitCode = 1; }
}

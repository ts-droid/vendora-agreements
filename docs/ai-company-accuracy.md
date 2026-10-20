# Real-provider company extraction evaluation

This evaluation is separate from the mocked-provider application tests. It calls the real exported `ai.reviewContract()` and scores `company_details` against fixed reference answers. Passing tests of the scorer or launcher is NOT a model-accuracy result.

## Preferred execution: the existing Railway service

The payload lives in `eval/company-accuracy/`, with its launcher in `scripts/run-ai-accuracy.cjs`. It ships with the normal repository deployment. The Railway service must run a commit containing both the company-import implementation and this evaluation. Do not change `railway.toml`, the service start command, or configure this as a deploy hook/cron job.

Connect to the existing **vendora-agreements** service using its dashboard **Copy SSH Command**, then run from the deployed project root:

```sh
npm run test:ai:check
npm run test:ai:smoke
```

`check` reports only file availability and credential-presence booleans; it makes zero AI calls and never prints secret values. `smoke` explicitly authorises three real review calls, one each for the selected cases. `npm run test:ai:all` explicitly runs all twelve cases once. The provider may charge for these requests. The launcher always runs once, not on application startup or every deployment.

The existing Railway `ANTHROPIC_API_KEY` and optional `ANTHROPIC_MODEL` are passed directly to the isolated evaluation process. If no model variable is configured, the same application default is used. No new GitHub secret is needed. The launcher does not pass production database, mail, webhook, Railway tokens or Node preload settings to its child process. It does not start `server.js` or change customer records. It preserves the benchmark rule of disabling model fallback.

Each explicit run writes to its own private temporary directory, for example `/tmp/vendora-ai-eval-XXXXXX/results.json`; the exact path is printed. Read or copy that report before redeployment because container-local temporary files are not durable. A GitHub-deployed Railway commit is recorded via `RAILWAY_GIT_COMMIT_SHA` when available; code and fixture hashes are also recorded. A successful deployment or preflight is not a completed AI test.

No credentials belong in chat, source, screenshots or logs. The optional manually dispatched GitHub workflow is an alternative only; using that alternative requires an Actions secret and model variable. There is no automatic push-triggered live evaluation.

## Corpus and scope

Twelve synthetic, explicitly nonbinding text excerpts with 49 fixed positive field labels cover all three agreement types: clean customer/supplier identity; Vendora versus counterparty; Danish names; supplier versus parent/brand owner; registered versus delivery address; contact versus signatory; missing jurisdiction; ambiguous parties; blank template; prompt injection; and bank/invoice contamination. Identifiers are fabricated, not validated registry data. Reference answers are never sent to the model. Prefilled form data deliberately belongs to a decoy.

This diagnostic corpus does not establish production accuracy on real agreements, PDF/scans, legal risk classifications, registry records or signatory authority. Deployment-specific stored playbook settings are not copied; the code's standard positions are tested. Add independently reviewed, de-identified real agreements and format cases before a release-quality accuracy claim. Repetitions measure stability, not additional independent documents. Do not tune on a hold-out and then describe it as untouched validation.

## Metrics and gates

Report case success, party selection, raw field precision/recall and evidence support, plus field metrics after application import guards. A wrong value is both an incorrect proposal and a missed correct value. Do not inflate the score by counting unused empty fields as correct. No predictions means undefined precision, not 100%. Provider failures are separate from extraction errors and cannot produce a passing run. Partial metrics are not complete-suite results.

Wrong parties, unsupported values and ungrounded quotes are critical failures in this small corpus; every selected case must pass. That gate is not a guarantee of future correctness. Human approval remains mandatory. A manually constructed wrong answer can attribute a logistics contractor's registration number to a customer while passing literal source checks. The fixed gold answer catches that limitation. It is not an observed live-model error.

The adapter records the requested model but does not expose resolved model ID/token usage to this runner; those are not invented. Both an absent key and absent explicit live opt-in produce a blocked result, null accuracy and exit code 2. Provider/adapter errors stop the run; no mocks are substituted. A timeout or launcher error is not success.

## Historical prerequisite result

The initial GitHub prerequisite run 39382248267 and live workflow attempt 39382954276 had no available `ANTHROPIC_API_KEY` and made zero live calls. This did not establish AI accuracy and says nothing about the Railway credential. Shipping this payload does not retroactively turn those blocked attempts into successful measurements.

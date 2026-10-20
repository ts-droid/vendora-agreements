# Real-provider company extraction evaluation

This evaluation is separate from the 123 mocked-provider application tests in PR #42. It exercises the real exported `ai.reviewContract()` and scores `company_details` against fixed reference answers. Passing the scorer's tests does NOT measure model accuracy.

## Corpus and scope

Twelve synthetic, explicitly nonbinding text excerpts with fixed expected values cover all three contract types: clean customer/supplier identity; Vendora versus the counterparty; Danish names; supplier versus parent/brand owner; registered versus delivery address; contact versus signatory; missing jurisdiction; ambiguous counterparties; a blank template; document prompt injection; and bank/invoice contamination. Names and identifiers are fabricated, not validated registry data. Reference answers are never sent to the provider. Existing form details deliberately belong to a decoy, testing benchmark-to-source leakage.

This initial corpus does not measure real customer-document performance, PDF/scanned-document reading, legal risk classification or a signatory's authority. It is a diagnostic suite, not a production accuracy estimate. Add independently reviewed, de-identified real agreements and document-format cases before a release-quality accuracy claim. Repeated calls on one document measure stability, not more independent documents. Do not tune on a proposed hold-out set and subsequently call it an untouched validation set.

## Metrics and gates

Report exact-case success, correct parties, raw field precision/recall, supported evidence, and the same field metrics AFTER the application's import guards. A wrong extracted value is both an incorrect suggestion and a missed correct value. Do not inflate accuracy by counting hundreds of unused blank fields as correct. Precision for no predictions is undefined, not 100%. Provider errors are distinct from extraction errors and can never produce a passing full run. Partial metrics must not be presented as complete-suite results.

Every wrong-party choice, invented/unsupported value or ungrounded quote is a critical finding in this small corpus. The fixed diagnostic gate requires every selected case to pass; this is not a guarantee of future correctness. Human approval of imports remains mandatory.

A scorer regression test already demonstrates a limitation of the existing validator: a registration number belonging to a logistics contractor can pass the literal source-quote check because it really occurs in the source. The fixed gold answer catches it. This is a manually constructed bad output, NOT an observed live-model mistake. `sourceVerified` establishes literal occurrence, not ownership by the correct company. No runtime guard or approval requirement is changed by this evaluation PR.

## Running

No production database, mails or signatures are used. Default is three real review calls once each. Full corpus is twelve; at most three repeats (36 calls). Calls use the adapter's existing output budget and incur provider charges. Automatic fallback to another model is disabled for measurement. `requestedModel`, code hashes and fixture hashes are recorded. The adapter does not expose resolved model ID/token usage, so these are not fabricated. The production server's custom stored playbook/environment is not copied into this test: the code's standard positions are tested.

Store `ANTHROPIC_API_KEY` as an Actions secret, never in source, screenshots, chat or a committed `.env`. Set repository variable `ANTHROPIC_MODEL` to the model configured for the deployment being compared. Missing credentials produce `blocked_missing_credential`, zero live calls, null metrics and exit code 2; no mock substitution is allowed.

Locally, with credentials already set securely in the environment:

```sh
node --test test/company-accuracy-eval.test.js
AI_EVAL_ALLOW_LIVE=1 AI_EVAL_SUITE=smoke node eval/company-accuracy/run.cjs
AI_EVAL_ALLOW_LIVE=1 AI_EVAL_SUITE=all AI_EVAL_REPEATS=3 node eval/company-accuracy/run.cjs
```

GitHub's `Live company extraction accuracy` workflow runs the scorer tests and a real-provider smoke evaluation, storing `results.json`. It has an initial tightly scoped push trigger on the evaluation branch and a manual dispatch entry. Manual dispatch in the UI requires the workflow on the default branch; until then a failed evaluation job can be re-run after the secret is configured. A run may stop on missing credentials, provider/model/configuration errors or accuracy findings. None should be relabelled green by skipping the live step.

## Current prerequisite check

The initial prerequisite run 39382248267 confirmed that `ANTHROPIC_API_KEY` was unavailable to this GitHub Actions job. It made zero provider calls. This says nothing about whether Railway has its own configured key. No live accuracy percentage has been established.

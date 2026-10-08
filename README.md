# Vendora Agreement Generator

Internal tool for drafting, negotiating, and signing Vendora Nordic AB reseller and distributor agreements. Staff sign in with Google (`@vendora.se`). Agreement records live in Postgres (`agreements`, `agreement_files`).

The app is deployed on Railway (project **Vendora agreements**, service `vendora-agreements`):

https://vendora-agreements-production.up.railway.app

Railway redeploys when `main` changes. Set the variables below on the service **before** relying on the new endpoints, and review the pull request before merging.

## Read-only export API

`GET /api/export/agreements`

For an internal assistant that can only make outbound HTTPS calls. The handler runs a single `SELECT` inside a Postgres `READ ONLY` transaction. It does not send email, change status, or return file bytes, signature images, update tokens, or agreement JSON.

### Auth

Send `Authorization: Bearer <EXPORT_API_KEY>`. The key is compared in constant time (SHA-256 of both sides, then `timingSafeEqual`).

| `EXPORT_API_KEY` | Result |
| --- | --- |
| unset or blank | `404` — the route is disabled, so shipping the code before the key exists changes nothing |
| set, header missing or wrong | `401` |
| set, header correct, no database | `503` |

30 requests per 10 minutes per client IP. Responses are `Cache-Control: no-store`. At most 2000 rows (newest `updated_at` first). When that cap is hit, `truncated` is `true` and the `X-Export-Truncated: true` header is set; narrow the query with `status` or `since`.

### Query

| Param | Meaning |
| --- | --- |
| `status` | Exact lifecycle status: `draft`, `invited`, `submitted`, `generated`, `pending_signature`, `vendora_signed`, `sent`, `signed`, `imported` |
| `since` | ISO date or date-time. A row matches when `created_at`, `updated_at`, `status_updated_at`, `last_reminder_at`, `vendora_signed_at`, or `signature_requested_at` is at or after this instant. A date with no time is UTC midnight. |
| `format` | `json` (default) or `csv` |
| `include_test` | Accepted and ignored. Rows are not marked as test data; everything matching `status` / `since` is returned. Filter further on the client if you need to. |

### JSON body

```json
{
  "agreements": [
    {
      "id": 12,
      "type": "ra",
      "counterparty_company": "Nordic Retail AB",
      "counterparty_name": "Nordic Retail AB",
      "contact_name": "Anna Andersson",
      "contact_email": "anna@example.com",
      "status": "signed",
      "created_at": "2026-03-01T12:00:00.000Z",
      "updated_at": "2026-04-02T08:30:00.000Z",
      "status_updated_at": "2026-04-02T08:30:00.000Z",
      "last_reminder_at": null,
      "vendora_signed_at": "2026-04-01T09:00:00.000Z",
      "signature_requested_at": "2026-03-31T15:00:00.000Z",
      "created_by_email": "sara@vendora.se",
      "created_by_name": "Sara",
      "file_count": 1
    }
  ],
  "truncated": false
}
```

`counterparty_company` is the legal name on the form (`data.name`). `counterparty_name` is the column as stored: the contact person at invite time, the company after the agreement is saved. `contact_name` / `contact_email` prefer the signatory, then the invite contact, then the notices or management contact. `created_by_email` comes from the linked user and is null if that user was removed (`created_by_name` is still the name captured on the row).

Timestamps are ISO 8601 UTC. The database does **not** keep a separate clock for every status, so there is no historical `invited_at` / `submitted_at` / fully-signed time once the row has moved on:

| What you wanted | Field to use |
| --- | --- |
| Created | `created_at` |
| Updated | `updated_at` |
| Last status change (invited, submitted, sent, fully signed, … while that is still the current status) | `status_updated_at` (null on rows that have never changed status; for an invite that is still `invited`, `created_at` is the invite time) |
| Last reminder | `last_reminder_at` |
| CEO signed for Vendora | `vendora_signed_at` |
| Sent to the CEO | `signature_requested_at` |

`format=csv` returns the same columns, with a `Content-Disposition` filename of `agreements.csv`. Cells that start with `=`, `+`, `-`, or `@` are prefixed so a spreadsheet does not treat them as formulas.

```bash
curl -sS -H "Authorization: Bearer $EXPORT_API_KEY" \
  "https://vendora-agreements-production.up.railway.app/api/export/agreements?status=signed&since=2026-01-01"

curl -sS -D - -o agreements.csv \
  -H "Authorization: Bearer $EXPORT_API_KEY" \
  "https://vendora-agreements-production.up.railway.app/api/export/agreements?format=csv"
```

## Agreement webhooks

Optional `POST` of JSON when an agreement is created, its status changes, a reminder is sent, or an invite/reminder email fails. Nothing is sent unless `AGREEMENT_WEBHOOK_URL` is set. Delivery is asynchronous: the user's request is not delayed or failed if the receiver is down. Timeout is 5 seconds, then up to two retries (about 0.4s and 1.2s apart). Network errors and HTTP 5xx are retried; HTTP 4xx is not. Redirects are not followed. Failures are written to the service log and then dropped.

### Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `AGREEMENT_WEBHOOK_URL` | yes, to enable | `https://…` receiver. Unset or blank disables the feature completely. |
| `AGREEMENT_WEBHOOK_SECRET` | no | Shared secret. When set, each request is signed. Whitespace around the value is ignored. |
| `AGREEMENT_WEBHOOK_SECRET_HEADER` | no | Header that carries the secret. Default `Authorization`, value `Bearer <secret>`. Any other header name (for example `X-Api-Key`) receives the secret with no `Bearer` prefix. |

When the secret is set, `X-Vendora-Signature` is the hex HMAC-SHA256 of the **raw** request body, keyed with that secret. Verify those exact bytes; re-serializing the JSON will not match.

```js
const crypto = require('crypto');
const expected = crypto.createHmac('sha256', process.env.AGREEMENT_WEBHOOK_SECRET)
  .update(rawBody)
  .digest('hex');
```

### Events

| `event` | When |
| --- | --- |
| `agreement.created` | A row is inserted (`draft`, `invited`, `generated`, …). This is the initial status; there is no separate status event for the insert. |
| `agreement.status_changed` | Status actually changes: counterparty submit, save, manual status, file upload (`signed`), request signature, CEO sign, CEO return, withdraw. `agreement.previous_status` is the status before the write. |
| `agreement.reminder_sent` | A reminder email was accepted by the mailer. `email_kind` is `reminder`. `reminder_kind` is `fill` (still invited) or `sign`. |
| `agreement.email_failed` | An invite or reminder email could not be sent (including "mail is not configured"). `error` is a short summary with secrets stripped. `email_kind` is `invite` or `reminder`. |

The `agreement` object uses the same fields as the export, plus `previous_status`. Invite failures that are not tied to a row the caller owns still notify, with id and timestamps null and whatever contact name, email, and type the request had. File contents, signature stamps, and capability tokens are never included.

```json
{
  "event": "agreement.status_changed",
  "occurred_at": "2026-04-02T10:15:00.123Z",
  "agreement": {
    "id": 12,
    "type": "ra",
    "counterparty_company": "Nordic Retail AB",
    "counterparty_name": "Nordic Retail AB",
    "contact_name": "Anna Andersson",
    "contact_email": "anna@example.com",
    "status": "submitted",
    "previous_status": "invited",
    "created_at": "2026-03-01T12:00:00.000Z",
    "updated_at": "2026-04-02T10:15:00.100Z",
    "status_updated_at": "2026-04-02T10:15:00.100Z",
    "last_reminder_at": null,
    "vendora_signed_at": null,
    "signature_requested_at": null,
    "created_by_email": "sara@vendora.se",
    "created_by_name": "Sara",
    "file_count": 0
  }
}
```

## Set the variables on Railway

Railway auto-deploys this service from `main`. Add the variables on the existing service; do not put the secrets in git.

1. Open the Railway project **Vendora agreements**.
2. Open the service **vendora-agreements** → **Variables**.
3. Add `EXPORT_API_KEY`. Generate it locally and paste the value (it is shown only in Railway after that):

   ```bash
   openssl rand -hex 32
   ```

4. To notify an assistant, also add `AGREEMENT_WEBHOOK_URL` (`https://…`) and, unless the receiver is on a private network you trust with an unauthenticated POST, `AGREEMENT_WEBHOOK_SECRET` (another `openssl rand -hex 32`). Set `AGREEMENT_WEBHOOK_SECRET_HEADER` only if the receiver does not want `Authorization: Bearer …`.
5. Saving variables redeploys the service. Until `EXPORT_API_KEY` is saved, `GET /api/export/agreements` stays a 404. Until `AGREEMENT_WEBHOOK_URL` is saved, no webhooks are sent.

Give the export key and the webhook secret to the assistant out of band. They are not returned by any API.

## Tests

No database is required for the unit tests (`npm test`). They cover metadata shaping, the read-only SQL shape, export auth (404 / 401 / 400 / 503), and webhook signing, headers, and retries.

After deploy, the curl commands above are the manual check against production. A wrong bearer token must return 401, and an empty `EXPORT_API_KEY` must leave the route at 404.

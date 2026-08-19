# Feedback API Contract

## Deployment boundary

- Client endpoint is configured by `DSH_FEEDBACK_ENDPOINT` (or the release build's equivalent controlled configuration). It must point to an HTTPS URL such as `https://feedback.example.com/v1/feedback`.
- The endpoint is implemented by the private Cloudflare Worker project in `github-issue-server/`.
- The Worker does not expose GitHub URLs to clients. It receives feedback, stores an idempotency receipt, queues Issue creation, and returns an internal receipt ID.
- Cloudflare Queues handles asynchronous delivery/retry; D1 stores receipt state and payload hash. The Worker uses a Cloudflare Rate Limiting binding at 10 requests/60 seconds per edge client IP, without storing the IP in D1 or application logs. The binding is eventually consistent and per Cloudflare location; a strict global quota would require an additional WAF rule.

## Request

`POST /v1/feedback`

Headers:

```text
Content-Type: application/json
Accept: application/json
Idempotency-Key: <random UUID per user submission>
```

Body, schema version `1`:

```json
{
  "schemaVersion": 1,
  "mode": "anonymous",
  "category": "bug",
  "title": "反馈标题",
  "body": "反馈正文",
  "signature": null,
  "diagnostics": null,
  "client": {
    "appVersion": "0.1.0",
    "platform": "darwin",
    "arch": "arm64",
    "profile": "web"
  }
}
```

Rules:

- `mode`: `anonymous` or `signed`.
- `category`: `bug`, `feature`, or `other`.
- `title`: trimmed, non-empty, max 160 characters.
- `body`: trimmed, non-empty, max 20,000 characters.
- `signature`: required only for `signed`, max 80 characters; omitted/null for `anonymous`.
- `diagnostics`: optional low-sensitivity Markdown block, max 8,000 characters; null means not shared.
- `client` contains only coarse version/platform data and no path, user, host, IP, token, configuration, session, or raw log.
- The Worker must not persist the request IP or feedback body in access/application logs. Cloudflare's infrastructure may still process network metadata according to its own policy.

## Response

Queued acceptance:

```http
HTTP/1.1 202 Accepted
```

```json
{
  "ok": true,
  "status": "queued",
  "receiptId": "fb_..."
}
```

The client displays this as “已收到，正在处理” and never displays a GitHub URL.

Error shapes:

- `400 { "ok": false, "code": "invalid_request", "message": "..." }`
- `409 { "ok": false, "code": "idempotency_conflict", "message": "..." }`
- `429 { "ok": false, "code": "rate_limited", "message": "..." }`
- `503 { "ok": false, "code": "temporarily_unavailable", "message": "..." }`

## Idempotency

- The desktop client creates one random UUID for each explicit submit action and reuses it for bounded network retries.
- The Worker stores `idempotencyKey` and a SHA-256 payload hash in D1.
- Repeating the same key with the same hash returns the original receipt/status and must not create a second Issue.
- Queue delivery also searches GitHub for the server-generated receipt marker before creating an Issue, covering redelivery after GitHub succeeded but D1 acknowledgement failed.
- Repeating the same key with a different hash returns `409`.
- Queue retries keep the same receipt ID. GitHub outage does not cause the desktop client to resubmit.

## Worker to GitHub

- Queue consumer creates the Issue with a GitHub App installation token.
- Labels are server-controlled, for example `feedback`, `feedback:anonymous`/`feedback:signed`, and `category:bug`/`category:feature`.
- Issue body is assembled server-side from structured fields; user text is treated as Markdown content and is not interpolated into server configuration.
- On GitHub failure, the Queue message is retried and eventually sent to a dead-letter queue. The receipt remains queryable internally; no GitHub URL is sent to the client.

## Health

`GET /healthz` returns `{ "ok": true, "service": "github-issue-server" }` and must not reveal GitHub credentials, queue contents, D1 details, or deployment metadata.

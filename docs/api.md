# suxos-net staging API

Base URL (staging): `https://suxos-net-staging.colinxs.workers.dev`

No real Cloudflare Access is in front of this staging deploy yet (see
`docs/design/suxos-net-design.md` §4-5 and the README's production-readiness
section) — every route below is reachable without auth today. Every response,
success or error, carries these headers:

```
X-Content-Type-Options: nosniff
Content-Security-Policy: default-src 'none'; frame-ancestors 'none'
Referrer-Policy: no-referrer
```

## Error shape

Every 4xx response returned by this API uses the same body shape instead of a bare
thrown exception or an ad hoc message:

```json
{ "error": "human-readable reason", "field": "optional-offending-field-name" }
```

`field` is present when the error is attributable to one specific request field
(a query param or a JSON body key); omitted for whole-request errors (e.g. malformed
JSON).

Wrong HTTP method on any route returns `405` with an `Allow` header naming the one
accepted method, rather than silently accepting anything.

---

## `GET /api/navigator`

The 2D navigator stub (design doc §2) — verbosity axis × time-scope axis.

**Query parameters** (both optional):

| name | type | allowed values | default |
|---|---|---|---|
| `verbosity` | string | `bare`, `oneline`, `paragraph`, `narrative` | `oneline` |
| `timeScope` | string | `week`, `year`, `all` | `week` |

**200 response:**

```json
{
  "verbosity": "oneline",
  "timeScope": "week",
  "entries": [
    {
      "id": "stub-001",
      "date": "2026-01-05",
      "title": "Sample Event A",
      "body": null,
      "citationIds": ["stub-cite-001"]
    }
  ],
  "generatedAt": "2026-07-17T00:00:00.000Z"
}
```

`body` is `null` at `bare`/`oneline` verbosity, a string at `paragraph`/`narrative`.
Data is synthetic stub content only — see the README.

**Errors:**

- `400 { "error": "...", "field": "verbosity" }` — `verbosity` not one of the allowed
  values.
- `400 { "error": "...", "field": "timeScope" }` — `timeScope` not one of the allowed
  values.
- `405` with `Allow: GET` — any method other than `GET`.

---

## `POST /api/qa`

The QA bot stub (design doc §3) — always returns a `not_implemented` shape, never a
fabricated answer or citation.

**Headers:** `Content-Type: application/json` required.

**Body:**

```json
{ "question": "What happened in March?" }
```

`question` must be a non-empty string.

**200 response:**

```json
{
  "question": "What happened in March?",
  "answer": "QA retrieval is not yet wired to the citation graph. This is a stub response.",
  "citations": [],
  "status": "not_implemented"
}
```

**Errors:**

- `400 { "error": "...", "field": "content-type" }` — missing/wrong `Content-Type`.
- `400 { "error": "request body must be valid JSON" }` — malformed JSON body.
- `400 { "error": "request body must be a JSON object" }` — body isn't a JSON object.
- `400 { "error": "...", "field": "question" }` — `question` missing, non-string, or
  empty/whitespace-only.
- `405` with `Allow: POST` — any method other than `POST`.

---

## `GET /healthz`

Liveness/identity check.

**200 response:**

```json
{ "ok": true, "staging": true, "identity": "dev@localhost" }
```

`identity` echoes `ACCESS_STAGING_IDENTITY` from `wrangler.jsonc` — the one shared
staging identity standing in for real per-recipient Cloudflare Access (see design doc
§4). This is not a real authentication check.

**Errors:**

- `405` with `Allow: GET` — any method other than `GET`.

---

## Internal tools (not HTTP routes)

`src/tools/verbositySummarizer.ts`, `src/tools/inconsistencyFlagger.ts`, and
`src/tools/citationIntegrity.ts` are pure TypeScript functions used internally
(currently by `navigator.ts` and by their own test suites) — they are not exposed as
HTTP endpoints. See the README's "Generic tools" section for what each one does.

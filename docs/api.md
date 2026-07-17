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

Real retrieval-backed QA (design doc §3, issue #31): the question is embedded and
matched against the `suxvault-notes` Vectorize index; an LLM only ever sees the
retrieved chunks as context and is never called at all if nothing clears the
similarity threshold. Requires a recipient session (see "Recipient auth" below).

**Headers:** `Content-Type: application/json` required. `Cookie: suxos_session=...`
required (recipient session from `POST /login`) — `401` without one.

**Body:**

```json
{ "question": "What happened in March?" }
```

`question` must be a non-empty string.

**200 response, match found:**

```json
{
  "question": "What happened in March?",
  "answer": "Based on the retrieved passages, this appears to say: ...",
  "citations": [{ "sourcePath": "records/example.md", "heading": "Section", "score": 0.83 }],
  "confidence": 0.83,
  "status": "answered"
}
```

**200 response, nothing above the similarity threshold (no LLM call is made):**

```json
{
  "question": "...",
  "answer": "I can't find anything in the indexed suxvault content that answers this question. No source was found, so I'm not going to guess.",
  "citations": [],
  "confidence": null,
  "status": "no_match"
}
```

**Errors:**

- `401` — missing/invalid/expired recipient session.
- `400 { "error": "...", "field": "content-type" }` — missing/wrong `Content-Type`.
- `400 { "error": "request body must be valid JSON" }` — malformed JSON body.
- `400 { "error": "request body must be a JSON object" }` — body isn't a JSON object.
- `400 { "error": "...", "field": "question" }` — `question` missing, non-string, or
  empty/whitespace-only.
- `405` with `Allow: POST` — any method other than `POST`.

---

## `POST /admin/sync-embeddings`

Operator-only (issue #30): re-chunks and re-embeds every markdown note in
`SuxOS/suxvault`@`main` via Workers AI (`@cf/baai/bge-base-en-v1.5`) and upserts the
result into the `suxvault-notes` Vectorize index. Idempotent — vector ids are derived
from `(sourcePath, chunkIndex)`, so re-running against unchanged content upserts the
same ids in place rather than creating duplicates. Not on a schedule yet; re-run this
manually (or wire a cron/webhook trigger) whenever suxvault content changes.

**200 response:**

```json
{ "filesScanned": 438, "chunksEmbedded": 1900, "vectorsUpserted": 1900 }
```

**Errors:**

- `502 { "error": "embedding sync failed: ..." }` — GitHub fetch, embedding, or
  Vectorize upsert failed partway through.
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

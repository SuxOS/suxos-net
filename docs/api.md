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

## `GET /demo/navigator`

Same navigator pipeline as `GET /api/navigator`, but rendered over the obviously
fictional dataset in `src/demo/demoData.ts` instead of the two-entry stub, so the real
`verbositySummarizer` tool has more than two entries to exercise. Additive — does not
replace `/api/navigator`.

**Query parameters** (both optional):

| name | type | allowed values | default |
|---|---|---|---|
| `verbosity` | string | `bare`, `oneline`, `paragraph`, `narrative` | `oneline` |
| `timeScope` | string | `week`, `year`, `all` | `all` |

Note the different default `timeScope` from `/api/navigator` (`all` here, `week`
there) — the demo dataset's dates are fixed in the past, so `week`/`year` are measured
relative to the *latest* demo record's date, not to today.

**200 response:**

```json
{
  "verbosity": "oneline",
  "timeScope": "all",
  "entries": [
    {
      "id": "demo-...",
      "date": "2025-03-01",
      "title": "...",
      "body": null,
      "citationIds": ["demo-cite-..."]
    }
  ],
  "generatedAt": "2026-07-17T00:00:00.000Z",
  "notice": "FICTIONAL DEMO DATA — not the user's real information. Do not treat as real."
}
```

**Errors:** same `verbosity`/`timeScope` `400`s and `405` as `GET /api/navigator`.

---

## `POST /demo/qa`

Demo QA over the fictional dataset — real keyword-overlap retrieval (not an LLM call),
returning matched records/claims with their own citations unchanged. Demonstrates the
"pointer, not chat" concept with an actual cited answer instead of `/api/qa`'s bare
`not_implemented` stub.

**Headers:** `Content-Type: application/json` required.

**Body:** same shape as `POST /api/qa` — `{ "question": "..." }`.

**200 response:**

```json
{
  "question": "What happened in March?",
  "matches": [
    { "id": "demo-...", "date": "2025-03-01", "text": "...", "citations": ["demo-cite-..."] }
  ],
  "status": "matched",
  "notice": "FICTIONAL DEMO DATA — not the user's real information. Do not treat as real."
}
```

`status` is `"no_match"` and `matches` is `[]` when no record or claim shares a
keyword with the question. `matches` entries without a `date` come from claims rather
than records.

**Errors:** same as `POST /api/qa` (missing/wrong `Content-Type`, malformed JSON,
non-object body, missing/empty `question`, `405` with `Allow: POST`).

---

## `GET /demo/flags`

Runs the `inconsistencyFlagger` and `citationIntegrity` internal tools (see below)
over the fictional demo dataset and returns every result together. No query
parameters; always reflects the full demo dataset.

**200 response:**

```json
{
  "selfConsistency": [
    { "claimIdA": "...", "claimIdB": "...", "relation": "appearsInconsistentWith", "confidence": 0.4, "note": "..." }
  ],
  "groundingSignals": [
    { "claimId": "...", "groundedBy": ["demo-cite-..."], "confidence": 0.4, "note": "..." }
  ],
  "referenceConsistency": [
    { "claimId": "...", "appearsInconsistentWith": "...", "confidence": 0.4, "note": "..." }
  ],
  "citationIntegrity": {
    "dangling": [],
    "clean": true,
    "recordsChecked": 0,
    "citationReferencesChecked": 0
  },
  "notice": "FICTIONAL DEMO DATA — not the user's real information. Do not treat as real."
}
```

Every `confidence` in `selfConsistency`/`groundingSignals`/`referenceConsistency` is
always strictly less than `1`, and every `note` is hedged, pattern-based language —
never an assertion that any claim is true, false, or verified. See the "Internal
tools" section below for what each tool does and why.

**Errors:** `405` with `Allow: GET` — any method other than `GET`.

---

## Internal tools (not HTTP routes)

`src/tools/verbositySummarizer.ts`, `src/tools/inconsistencyFlagger.ts`, and
`src/tools/citationIntegrity.ts` are pure TypeScript functions used internally
(by `navigator.ts`/`demo/demoNavigator.ts`, by `demo/demoFlags.ts` which exposes
`inconsistencyFlagger`'s and `citationIntegrity`'s output via `GET /demo/flags` above,
and by their own test suites) — they are not exposed as standalone HTTP endpoints. See
the README's "Generic tools" section for what each one does.

This document covers every route `src/index.ts` on this branch actually serves. Other
suxos-net branches/PRs may add further routes (e.g. access scoping, an audit log,
trusted-reference curation) — once one of those merges to `main`, update this file in
the same PR or a prompt follow-up.

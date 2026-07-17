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

## `POST /api/review`

Reviewer-facing record-integrity pass (design doc §1: "never ask a reader to take the
user's word for it"). Wires the four pure tools in `src/tools/` —
`findInconsistencies`, `findGroundingSignals`, `flagAgainstReferences`,
`checkCitationIntegrity` — into a single response over a caller-supplied set of claims.

**Headers:** `Content-Type: application/json` required.

**Body:**

```json
{
  "claims": [
    { "id": "claim-a", "text": "...", "citations": ["cite-1"], "confidence": 0.8 }
  ],
  "references": [
    { "id": "ref-1", "text": "...", "source": "Some Vetted Source", "sourceUrl": "https://..." }
  ],
  "knownCitationIds": ["cite-1", "cite-2"]
}
```

- `claims` (required): a non-empty array of `{ id, text, citations, confidence? }`,
  capped at 200 entries. `id` and `text` are strings (`id` non-empty), `citations` is
  an array of strings, `confidence` if present is a number. Each claim's `text` is
  capped at 10,000 characters, `citations` at 50 entries, and each citation id at 500
  characters.
- `references` (optional): a hand-curated bibliography, `{ id, text, source, sourceUrl? }[]`,
  capped at 200 entries, compared against every claim via `flagAgainstReferences`.
  Each reference's `text` is capped at 10,000 characters. Defaults to `[]` (no
  reference-consistency flags) when omitted — this endpoint never pulls references
  from open/general knowledge at runtime.
- `knownCitationIds` (optional): the authoritative set of citation ids to check every
  claim's own citations against via `checkCitationIntegrity`. Omitted rather than
  defaulted — with `suxvault` currently empty there is no real citation authority this
  Worker can assume, so when this is omitted `citationIntegrity` in the response is
  `null` rather than a fabricated "everything clean" or "everything dangling" default.

**200 response:**

```json
{
  "inconsistencies": [
    {
      "claimIdA": "claim-a",
      "claimIdB": "claim-b",
      "relation": "appearsInconsistentWith",
      "confidence": 0.51,
      "note": "Claim claim-a and claim claim-b appear inconsistent — cite both and let the reader judge."
    }
  ],
  "groundingSignals": [],
  "referenceFlags": [],
  "citationIntegrity": null,
  "claimsChecked": 2,
  "generatedAt": "2026-07-17T00:00:00.000Z"
}
```

Every flag/signal is hedged, pattern-based output with `confidence < 1` — see the
TSDoc on each tool in `src/tools/inconsistencyFlagger.ts` for the non-negotiable
wording contract. `citationIntegrity` (when not `null`) is the plain structural
`CitationIntegrityReport` from `src/tools/citationIntegrity.ts` — not hedged, since
whether a citation id resolves is a fact about the data, not an interpretive claim.

**Errors:**

- `400 { "error": "...", "field": "content-type" }` — missing/wrong `Content-Type`.
- `400 { "error": "request body must be valid JSON" }` — malformed JSON body.
- `400 { "error": "request body must be a JSON object" }` — body isn't a JSON object.
- `400 { "error": "...", "field": "claims" }` — `claims` missing, empty, over 200
  entries, containing a malformed claim, a claim with an over-length `text`, or a claim
  with too many/over-length `citations`.
- `400 { "error": "...", "field": "references" }` — `references` present but malformed,
  over 200 entries, or containing a reference with an over-length `text`.
- `400 { "error": "...", "field": "knownCitationIds" }` — `knownCitationIds` present but
  not an array of strings.
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

## Internal tools

`src/tools/verbositySummarizer.ts`, `src/tools/inconsistencyFlagger.ts`, and
`src/tools/citationIntegrity.ts` are pure TypeScript functions. `verbositySummarizer.ts`
is consumed by `navigator.ts`; `inconsistencyFlagger.ts` and `citationIntegrity.ts` are
consumed by `review.ts`, which backs `POST /api/review` above. All three also have their
own test suites. See the README's "Generic tools" section for what each one does.

# suxos-net

A shareable, access-gated site for a small set of named people in the user's life — care
team, family, others they choose to invite — to navigate a large, long-span personal record
without reading one giant file front to back. Not a public/persuasion surface: a bounded,
invited audience, same auth model as `suxdash` (Cloudflare Access). Full design:
[`docs/design/suxos-net-design.md`](docs/design/suxos-net-design.md).

## Status: staging only

This repo is a Worker deployed live at `https://suxos-net-staging.colinxs.workers.dev`
(real deploy, real KV namespace). `suxvault` PR #1 has since merged 438+ real files, but
`/api/navigator` and `/api/qa` are not wired to that real content yet — they still serve
the synthetic `STUB_ENTRIES` placeholder data ("Sample Event A", etc.), tracked in #41.
Never treat anything `src/navigator.ts`/`src/qa.ts` return today as real. See
"Production-readiness status" below for exactly what is and isn't hardened.

`npm run deploy` runs `wrangler deploy` against this staging Worker's existing name
(`suxos-net-staging` in `wrangler.jsonc`) — safe because `/api/navigator`/`/api/qa` still
don't serve real suxvault content (#41), and there's no custom DNS attached.

## Local dev

```
npm install
npm run dev
```

This starts `wrangler dev` locally (port 8790, see `wrangler.jsonc`). There is no Cloudflare
Access edge in local dev — the Worker instead treats every request as the one staging
identity declared in `wrangler.jsonc`'s `vars.ACCESS_STAGING_IDENTITY` (`dev@localhost` by
default). That mirrors the design doc's "one shared test/dev identity" plan for tonight,
without wiring real Access.

Routes:

- `GET /api/navigator?verbosity=<bare|oneline|paragraph|narrative>&timeScope=<week|year|all>`
  — the 2D navigator stub (see `src/navigator.ts`).
- `POST /api/qa` with `{ "question": "..." }` — the QA bot stub (see `src/qa.ts`); always
  returns a `not_implemented` shape, never a fabricated answer or citation.
- `POST /api/review` with `{ "claims": [...], "references": [...] }` — the
  reviewer-facing record-integrity endpoint (see `src/review.ts`); runs
  `findInconsistencies`, `findGroundingSignals`, `flagAgainstReferences`, and
  `checkCitationIntegrity` over the submitted claims/references, bounded array-length
  and per-field text-length caps so the pairwise checks stay a fixed worst case per
  request.
- `GET /healthz`

Full request/response/error shapes for all four routes: [`docs/api.md`](docs/api.md).

## Try it live — fictional demo data

`/api/navigator`/`/api/qa` aren't wired to real `suxvault` content yet (#41), so to show
the pipeline actually working end-to-end there's a self-contained, obviously-fictional
demo dataset baked into this repo (`src/demo/demoData.ts` — a made-up persona, "Jordan
Rivers," with invented dates, events, medications, and citations spanning a few fictional
years). It never touches `suxvault` and is completely separate from the still-stub
`/api/*` routes above.

- `GET /demo/navigator?verbosity=<bare|oneline|paragraph|narrative>&timeScope=<week|year|all>`
  — the real navigator/verbositySummarizer pipeline over the fictional dataset. Try:
  https://suxos-net-staging.colinxs.workers.dev/demo/navigator?verbosity=oneline&timeScope=year
- `POST /demo/qa` with `{ "question": "..." }` — simple keyword-match retrieval (not an
  LLM call) over the fictional records/claims, returning real cited matches. Demonstrates
  the "pointer, not chat" concept (design doc §3) end-to-end.
- `GET /demo/flags` — runs `findInconsistencies`, `findGroundingSignals`,
  `flagAgainstReferences`, and `checkCitationIntegrity` (all the real tools from
  `src/tools/`) over the fictional dataset, so you can see an actual conflicting-claim
  flag, an actual grounding signal, an actual reference-consistency flag, and an actual
  dangling-citation flag fire on realistic-shaped data.
- `GET /demo/highlights` — inline tone + possible-inconsistency highlights (design doc
  §Feature 4): `toneHighlighter.ts`'s `findToneHighlights` over the fictional testimony
  documents, plus `inconsistencyFlagger.ts`'s self-consistency/reference-consistency
  passes over the fictional claims. A testimony document can only ever get a `tone`
  highlight, never a `possible-inconsistency` one — structurally, since testimony
  documents are never passed to the inconsistency checks.

Every response from `/demo/*` includes a `notice` field restating that the data is
fictional. See the top-of-file comment in `src/demo/demoData.ts` for the full
disclaimer.

## Tests

```
npm test
```

`src/navigator.test.ts` and `src/qa.test.ts` check the structural shape of the stub
responses (every verbosity × time-scope combination, invalid inputs, the QA stub's
never-fabricate contract) — not real data. `src/index.test.ts` exercises the live routing
layer directly (bad-input 400s, wrong-method 405s, security headers on both success and
error paths) — see "Production-readiness status" below.

## Generic tools (`src/tools/`)

Two standalone, reusable tools that operate on abstract structured records/claims, not
on any real content:

- **`verbositySummarizer.ts`** — the shared verbosity-axis renderer (bare → oneline →
  paragraph → full) that `navigator.ts` calls into rather than duplicating the logic.
  Pure function, no I/O.
- **`inconsistencyFlagger.ts`** — a neutral instrument over an array of claims,
  checked against two sources:
  - **Self-consistency** (`findInconsistencies`) — *candidate* pairwise conflicts
    between claims in the same record (a red flag for a reviewer, e.g. an attorney,
    to look closer at), plus the complementary green flag (`findGroundingSignals`):
    claims backed by 2+ independent citations with no detected conflict, useful to a
    reviewer, e.g. a doctor, checking that their reasoning is well-supported.
  - **Reference-consistency** (`flagAgainstReferences`) — *candidate* conflicts
    between a claim and a small, explicitly human-curated set of trusted references
    (`TrustedReference[]`, a hand-vetted bibliography). This reference set is
    intentionally never auto-populated from open/general knowledge at runtime — only
    added to by a human, explicitly — so every reference-consistency flag stays
    traceable to one specific, named, vetted source.

  None of these functions ever assert anything is true, false, verified, confirmed,
  valid, or wrong — every output is hedged, pattern-based, and `confidence < 1`. All
  three are a simple keyword/negation heuristic today, explicitly not real NLP — see
  the TODO comments in the file for what a production version needs. Deterministic,
  offline, no LLM calls.
- **`citationIntegrity.ts`** — `checkCitationIntegrity(records, knownCitationIds)`
  walks any citation-bearing record (either a `citationIds` or `citations` field) and
  flags citation ids that don't resolve against a known citation set — catching
  dangling/broken citation links before a reader sees a claim silently pointing at
  nothing. Unlike `inconsistencyFlagger.ts`, this one is **not** hedged: whether a
  citation id exists is a plain structural fact about the data, not an interpretive
  claim, so its output uses plain "missing citation" wording on purpose. Pure
  function, no I/O.
- **`toneHighlighter.ts`** — `findToneHighlights(sources)`, the tone-highlight half of
  Feature 4: a curated intensifier/absolutist/hostile-register marker list (not
  sentiment analysis) flags phrases as "appears strongly worded," descriptive only,
  never judgmental about the writer. Same hedging contract as `inconsistencyFlagger.ts`
  — `confidence < 1`, no assertion of fact. Pure function, no I/O.

## Production-readiness status

**Code-quality hardening that's in place today:**

- Every HTTP route validates its inputs explicitly and returns a structured
  `{ error, field? }` 400 instead of ever throwing/500ing on bad input (`src/index.ts`,
  tested in `src/index.test.ts`).
- Every response carries `X-Content-Type-Options`, `Content-Security-Policy`, and
  `Referrer-Policy` headers — reasonable defaults ahead of real Access, not a
  replacement for it.
- Methods are restricted per route (`GET`-only navigator/healthz, `POST`-only qa) with
  `405 + Allow` on mismatch rather than silently accepting anything.
- A dedicated citation-integrity checker (`citationIntegrity.ts`) exists to catch
  dangling citation references structurally, with test coverage.
- `docs/api.md` documents every route's params, response shape, and error shape for
  anyone (including a doctor's or attorney's technical staff) inspecting the API.

**Deliberately still deferred — "production-grade code" is not the same claim as
"ready to receive real medical/legal content," and this repo does not conflate the
two:**

- **Real per-recipient auth now exists.** A real username/password system gates
  `/api/*` behind a signed session cookie (`POST /login`, `POST /logout`,
  `POST /logout-everywhere`), with operator-only account provisioning/reset/revocation
  and an audit log — see
  `docs/superpowers/specs/2026-07-17-real-access-and-retrieval-design.md` §1 and
  [`docs/api.md`](docs/api.md) for the full route surface. This supersedes the design
  doc's original "one shared staging identity, per-recipient Access deferred" plan
  (design doc §4, now marked superseded).
- **Real content exists in `suxvault`** (PR #1 merged 438+ files), but `/api/navigator`
  and `/api/qa` are not wired to it yet — they still serve synthetic `STUB_ENTRIES`
  placeholder data, tracked in #41. Don't overclaim this as done until #41 lands.
- **No custom domain / DNS cutover to `suxos.net`.**
- **No real QA retrieval.** `src/qa.ts` is still a stub pending #41/F-005/F-028.
- **The heuristics in `inconsistencyFlagger.ts` are not real NLP** — see the TODOs in
  that file.

Do not treat this Worker as safe to receive real personal, medical, or legal content
until the `/api/navigator`/`/api/qa` real-data wiring (#41) above is closed, with the
user present.

## Explicitly deferred (not this repo, not tonight)

*This section describes the original scaffold-night plan (2026-07-17). Two of its items
have since shipped — see "Production-readiness status" above for current reality:*

- ~~**Real content.** `suxvault` stays empty structure until populated with the user
  present.~~ Shipped: `suxvault` PR #1 merged 438+ real files. `/api/navigator`/`/api/qa`
  are not wired to it yet (tracked in #41).
- ~~**Per-recipient OAuth / Cloudflare Access invites.** v1 uses one shared staging
  identity; real named-recipient Access policy is a separate, later step.~~ Shipped, via
  a different mechanism than originally planned: real per-recipient username/password
  auth (not Cloudflare Access) — see `docs/api.md`.
- **Live DNS cutover to `suxos.net`.** Still deferred.
- **Real QA retrieval.** `src/qa.ts` is a stub pending #41/F-005 (semantic vault search)
  and F-028 (citation graph) — see `FEATURE-IDEAS.md` in the workspace root.
- **Pipeline wiring.** No `issue-build.yml`/`automerge.yml` yet — this repo was scaffolded
  directly rather than through the autonomous pipeline (see design doc §6).

# suxos-net

A shareable, access-gated site for a small set of named people in the user's life — care
team, family, others they choose to invite — to navigate a large, long-span personal record
without reading one giant file front to back. Not a public/persuasion surface: a bounded,
invited audience, same auth model as `suxdash` (Cloudflare Access). Full design:
[`docs/design/suxos-net-design.md`](docs/design/suxos-net-design.md).

## Status: staging only

This repo is a minimal Worker skeleton. **No real content, no real deploy.** `suxvault` is
currently empty structure, so every entry this Worker returns is an obviously-synthetic
placeholder ("Sample Event A", etc.) — never treat anything in `src/navigator.ts` as real.

Do not run `npm run deploy` / `wrangler deploy` against this config. It intentionally has no
real KV namespace id and no Cloudflare Access policy attached.

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
- `GET /healthz`

## Tests

```
npm test
```

`src/navigator.test.ts` and `src/qa.test.ts` check the structural shape of the stub
responses (every verbosity × time-scope combination, invalid inputs, the QA stub's
never-fabricate contract) — not real data.

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

## Explicitly deferred (not this repo, not tonight)

- **Real content.** `suxvault` stays empty structure until populated with the user present.
- **Per-recipient OAuth / Cloudflare Access invites.** v1 uses one shared staging identity;
  real named-recipient Access policy is a separate, later step.
- **Live DNS cutover to `suxos.net`.**
- **Real QA retrieval.** `src/qa.ts` is a stub pending F-005 (semantic vault search) and
  F-028 (citation graph) — see `FEATURE-IDEAS.md` in the workspace root.
- **Pipeline wiring.** No `issue-build.yml`/`automerge.yml` yet — this repo was scaffolded
  directly rather than through the autonomous pipeline (see design doc §6).

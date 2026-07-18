# CLAUDE.md

Persistent notes for automated builders working this repo.

## SuxOS/suxvault is unreachable from the builder token

The builder's GitHub token cannot reach the `SuxOS/suxvault` repo — `gh api repos/SuxOS/suxvault` and
`gh api repos/SuxOS/suxvault/contents/...` both 404 (verified 2026-07-17, see issue #46). Any open issue
that requires reading real data/content from `suxvault` is **not buildable** in this sandbox until that
repo is made reachable (org access grant) or its needed content is mirrored/vendored into `suxos-net`.
If you pick up such an issue, drop it immediately as blocked rather than re-discovering the 404 — note in
your final message that it's blocked on suxvault access, not on missing implementation work.

## Some issues target code that only exists on an unmerged sibling PR branch

PR #35 (`feat/recipient-auth`, `hold` label, gates the v2.2 release) adds `src/auth/*` and touches
`src/index.ts` in ways that have **not landed on `main`** — none of that code exists on `main` or on a
fresh `bot/issue-build-*` branch cut from it (verified 2026-07-18, issue #49). Follow-up issues filed
against that diff (e.g. #49's TOCTOU-race fix, and likely #18/#19/#20 which build on the same recipient-auth
foundation) name files/functions (`src/auth/store.ts`, the `/login`+`/admin/*` rate-limit call sites) that
simply aren't present to edit. Building them here would mean either reimplementing #35's ~950 lines from
scratch (scope creep, duplicate/diverging history) or merging #35 into `main` through a side-door PR — the
issue text for #49 explicitly says it does **not** remove the `hold` on #35, i.e. #35 must stay separate
and unmerged. This per-batch pipeline only ever ships a new PR against `main`; it has no way to push fix
commits onto another open PR's branch. If you pick up an issue like this, drop it and say so — it needs a
human (or a differently-scoped run) to push directly onto `feat/recipient-auth`, or it needs #35 merged
first, neither of which this pipeline shape can do.

## A real Durable Object atomic-counter primitive now exists on `main` (issue #55)

`src/durableObjects/rateLimitCounter.ts` (`RateLimitCounter`, bound as `RATE_LIMITER` in `wrangler.jsonc`)
is the atomic increment-and-check primitive that #49, #24, and #18/#19/#20 each independently said they
needed and didn't have. Reuse it (or its pattern) rather than re-deriving another one. Two things about
its shape are load-bearing, not incidental: (1) it deliberately implements the plain `fetch`-based
`DurableObject` interface, **not** `import { DurableObject } from "cloudflare:workers"` — this repo's
`npm test` runs under plain-Node vitest with no Miniflare/workerd pool, and importing `cloudflare:workers`
would break at import time outside the real Workers runtime; (2) tests exercise it through
`src/testUtils/durableObject.ts`'s in-memory fake, which queues calls per DO-instance name so only one
`fetch()` runs at a time — that queueing is what makes the fake capable of actually catching a concurrency
regression (an unserialized fake would race exactly like the KV version this replaced, silently).

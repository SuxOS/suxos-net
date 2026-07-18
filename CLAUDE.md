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

### It's not just #35 — several never-merged foundations strand whole issue clusters

The same root cause (an earlier `bot/issue-build-*` branch built real code, was never merged to `main`,
and follow-up issues were then filed against that unmerged diff as if it were live) recurs beyond #35.
Verified 2026-07-18 (issue #51) via `git ls-tree -r main --name-only`: none of `src/review.ts`,
`src/auth/`, `src/audit/`, or `src/access/` exist on `main` today, even though commits building them
exist on dangling branches (e.g. `src/review.ts` on `origin/bot/issue-build-29577656796`; the
access/audit pair on `origin/bot/issue-build-29600508994`). Known-stranded open issues as of 2026-07-18:
`#5, #9, #10, #12, #13` (target `src/review.ts` / `handleReview` / `POST /api/review`), `#18, #19, #20`
(access-scoping/trusted-reference/audit-log layer on top of `src/auth/*`, same foundation as #35's
`hold`), and `#32, #37, #38` (portal routes that depend on this foundation plus suxvault — also see the
suxvault-access note above). Before starting any issue, check whether it names a file under `src/review.ts`,
`src/auth/`, `src/audit/`, or `src/access/` — if so, confirm with `git ls-tree -r main --name-only` that
the file still doesn't exist before assuming this note is stale, then drop the issue as blocked rather
than rebuilding the foundation from scratch or re-deriving this from first principles.

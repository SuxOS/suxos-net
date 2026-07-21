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

### Update, same day (2026-07-18): the `#35` foundation landed; the `src/review.ts` cluster is now built too

Both bullets above went stale within the same day they were written — a concrete example of why this
file says to *verify*, not just trust the note. PR #35 merged to `main` (commit `aa66e05`, closing #18);
`src/auth/*` now exists on `main`, so the "#18/#19/#20 blocked on unmerged auth foundation" claim no
longer holds for #19/#20 (re-check `git ls-tree` before picking them up — they may still be legitimately
large/unbuilt, just not for *that* reason anymore). Separately, this same PR built `src/review.ts` and
`POST /api/review` (issue #5) with the array-length and per-field text-length caps (#9, #13) and the
single-pass `findInconsistencies` computation (#10) designed in from the start, so `#5, #9, #10, #13` are
no longer stranded either — only `#12` (a labels-only issue, already independently resolved — see `gh
label list`) was dropped. `#32, #37, #38` still depend on suxvault access and are unaffected. Lesson: a
"known-stranded" list is a snapshot, not a standing fact — the moment one builder actually lands a
foundation, every issue in that cluster's status flips, and nothing auto-updates this file to say so.

## A closed issue is not proof its code landed — check the diff, not just the status

Verified 2026-07-18 (issue #32 triage): PR #42 (`build: drain low-priority backlog`, merged) wrote `Closes
#30` and `Closes #31` in its body, which auto-closed both via GitHub's magic-keyword handling — but PR
#42's actual diff only touches `demo.test.ts`/`index.test.ts`/`index.ts`, never `src/qa.ts` or
`src/embeddings/*`. The real implementation for #30/#31 sits unmerged in draft PR #34
(`feat/real-qa-retrieval`, `CONFLICTING` mergeable state). `src/qa.ts` on `main` is still the original stub
— confirmed by reading the file, not by trusting `state_reason: "completed"`. If an issue you're about to
build (or an issue another one depends on, like #32 on #30/#31) shows as closed, don't take that as given:
grep/read the file(s) it claims to touch on `main` before relying on it. A batch PR's `Closes #N` list is
only as trustworthy as whoever wrote it — it is not a substitute for checking the tree.

## A `building` label doesn't mean the foundation exists on `main` yet either

Verified 2026-07-18 (issues #65/#71 triage): both name files under `src/references/` (`store.ts`,
`guard.ts`, a `listReferences` function) that issue #19 is supposed to add — but as of this check `git
ls-tree -r main --name-only` shows no `src/references/` directory at all, even though #19 is labeled
`building` (an in-progress claim, not a completed one). Same root cause as the `#35`/`src/review.ts`
clusters above, just caught earlier this time: don't infer a dependency has landed from its label or from
another issue's prose — `git ls-tree`/grep `main` for the actual file before building on top of it. If it's
not there, drop and release the claim; the foundation issue may still be mid-build by a concurrent run.

## #30/#31 (real QA retrieval) are already built — on an unmerged draft PR, not on `main`

Verified 2026-07-19: `src/qa.ts` on `main` is still the stub (`status: "not_implemented"`), but draft PR
#34 (`feat/real-qa-retrieval`, mergeable state `CONFLICTING`) already implements both #30 (Vectorize
embedding pipeline, `src/embeddings/*`) and #31 (real `/api/qa` synthesis) with passing tests. This is the
same shape as the `#35`/`src/review.ts` situation above: a batch pipeline can only open new PRs against
`main`, it cannot push fix/rebase commits onto another open PR's branch, so #30/#31 are not buildable here
until a human merges/rebases #34. #32 (real frontend route) depends on #30/#31 landing plus suxvault
access, so it's blocked transitively. Before re-attempting #30/#31/#32, check whether PR #34 has merged.

## `SuxOS/.github` (the reusable-workflow repo) is also unreachable from the builder token

Verified 2026-07-19 (issue #67 triage): `gh api repos/SuxOS/.github` 404s, same as the `suxvault`
unreachability noted above. `.github/workflows/issue-build.yml` in this repo just does `uses:
SuxOS/.github/.github/workflows/issue-build.yml@main` — the actual logic that generates a batch PR's body
(including its `Closes #N` list, the bug flagged in #67) lives in that unreachable repo, not in this one.
Any issue whose fix requires editing that reusable workflow is not buildable here for the same reason as
suxvault-dependent issues: drop it as blocked on repo access, don't try to "fix" it by editing something in
this repo that only calls the real logic.

## `RateLimiterDO` (`src/auth/rateLimiter.ts`) is also the atomic-KV-write primitive for `src/auth/store.ts`

Added 2026-07-19 (issue #84): Cloudflare KV has no compare-and-swap, so any `kv.get`-then-`kv.put` on the
same key racing another writer for that key can silently drop one side's change. `createAccount`,
`resetPassword`, and `revokeSessions` in `src/auth/store.ts` all route their account-record writes through
`RateLimiterDO`'s `"kvMerge"` op (`atomicKvMerge` in `rateLimiter.ts`) instead of writing KV directly — the
DO's per-id input gate serialises the whole read-modify-write, closing the race, and this reuses the
already-provisioned `RATE_LIMITER` binding rather than needing a new Durable Object class + wrangler
migration. If you add another mutating field to the `Account` record (or any other KV record that can be
written by more than one caller), reuse `atomicKvMerge` rather than writing a fresh `kv.get`/`kv.put` pair —
that plain pattern is exactly the bug #84 fixed.

## Issues #67 and #75 are structurally unbuildable by this pipeline, not just hard — stop re-attempting them the same way

Verified 2026-07-21: both have now failed 4 separate batch-build attempts (gates never even reached) because
neither is a code-writing task this pipeline shape can do. #67 wants a fix inside the reusable workflow that
generates a batch PR's `Closes #N` list — that logic lives in `SuxOS/.github`, which 404s for the builder
token (see the `SuxOS/.github` note above); there is nothing to edit in this repo's tree. #75 wants PR #34
(`feat/real-qa-retrieval`, still `mergeable=CONFLICTING`) rebased and landed — this pipeline can only open new
PRs against `main`, it cannot push commits onto another open PR's branch. Repeatedly reassigning either to a
fresh builder run just burns another 22+ comment cycle to rediscover the same 404 / can't-push-to-other-branch
facts. If you land here again: don't retry the same way — either drop with the same reasoning (releasing the
claim so it doesn't clog `building`), or, if repeated no-op retries are themselves the problem, flag it to a
human for an out-of-band fix (org access grant for #67's true fix location, a manual rebase+push for #75)
rather than looping the pipeline on it again.

## #37 and #38 (portal document viewer + annotation layer) are blocked on the same PR #34 foundation as #30/#31/#32

Verified 2026-07-21 (issues #30/#31/#32/#37/#38 triage): PR #34 (`feat/real-qa-retrieval`) is still open with
`mergeable: CONFLICTING`, so #30/#31/#32 remain not-buildable per the note above. #37 and #38 (portal spec
Features 2 and 3, `docs/superpowers/specs/2026-07-17-portal-feature-set-design.md`) each say so explicitly in
their own issue text — #37: "DEPENDS ON: real /api → suxvault wiring (foundation) landing first", #38:
"DEPENDS ON: Feature 2 (document viewer) + real /api wiring" — i.e. #38 depends on #37 which depends on #30/#31
which sit unmerged in #34. That makes the whole #30/#31/#32/#37/#38 chain one blocked cluster, not five
separate ones. Before re-attempting any of them, check whether PR #34 has merged; until then all five drop
as blocked with the same root cause.

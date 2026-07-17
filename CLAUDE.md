# CLAUDE.md

Persistent notes for automated builders working this repo.

## SuxOS/suxvault is unreachable from the builder token

The builder's GitHub token cannot reach the `SuxOS/suxvault` repo — `gh api repos/SuxOS/suxvault` and
`gh api repos/SuxOS/suxvault/contents/...` both 404 (verified 2026-07-17, see issue #46). Any open issue
that requires reading real data/content from `suxvault` is **not buildable** in this sandbox until that
repo is made reachable (org access grant) or its needed content is mirrored/vendored into `suxos-net`.
If you pick up such an issue, drop it immediately as blocked rather than re-discovering the 404 — note in
your final message that it's blocked on suxvault access, not on missing implementation work.

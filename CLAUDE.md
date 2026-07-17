# CLAUDE.md

Repo-specific guidance for automated builds in suxos-net.

- Before assuming an issue's target code doesn't exist on your branch, check
  `gh pr list --state open` and `git log --oneline --all --graph`. This repo's
  issue-build pipeline sometimes opens several sibling PRs off the same main commit in
  one batch, so a bug-fix issue can describe code that only exists in another
  still-open, unmerged PR branch (not yours, not main). If so, `git merge` that PR's
  branch into yours (usually clean — sibling batches tend to touch disjoint files)
  before applying the fix, rather than re-implementing the feature from scratch — and
  flag the now-superseded sibling PR(s) for closure in your final message so they
  don't get merged separately and conflict.
- To confirm a sibling PR is fully superseded (not just touched) after merging its
  branch in, run `git merge-base --is-ancestor origin/<sibling-branch> HEAD` for each
  open sibling PR — this catches transitive chains (PR C merged PR B's branch, which
  already contained PR A's branch) that a quick `git log --graph` skim can miss.

# suxos.net — gated record portal · design

Status: **Staging build in progress (2026-07-17, overnight).** Not live. No real content
loaded — `suxvault` is currently empty structure, which is why scaffolding against it is
safe. Live cutover to real content and real named recipients happens with the user present,
not before.

> **Superseded (2026-07-23):** §4 "Auth" below describes the original plan — one shared
> staging identity, per-recipient Cloudflare Access invites deferred. That plan has been
> superseded: real per-recipient username/password auth has since shipped (see
> `docs/superpowers/specs/2026-07-17-real-access-and-retrieval-design.md` §1 for the design,
> and [`docs/api.md`](../api.md) for the live `/login`/`/logout`/session-cookie route
> surface). §4 is left below for historical context, not deleted — §1-3 framing is still
> accurate.

## 1. Purpose

A shareable, access-gated site for a small set of named people in the user's life — care
team, family, others they choose to invite — to navigate a large, long-span personal record
without reading one giant file front to back. Not a public/persuasion surface: a bounded,
invited audience, same auth model as `suxdash` (Cloudflare Access).

Design principle carried through every part of this: **never ask a reader to take the
user's word for it.** Everything the portal shows is a pointer into the record (see F-028,
the citation graph in `FEATURE-IDEAS.md`), and any AI-added signal (tags, summaries) is
always labeled as a suggestion, not fact.

## 2. The 2D navigator (replaces "timeline vs. report" as two features)

One control, two axes:

- **Verbosity** (bare event list → one-line-per-event → paragraph → full narrative)
- **Time-scope** (a week → the whole span)

Wide time-scope + high verbosity is self-limiting by the renderer (not enough screen for
full paragraphs across a decade) — no special-casing needed. "Timeline" and "report" are
just the two corners of this control, not separate views to keep in sync.

## 3. QA as pointer-routing, not chat

Every answer is retrieval over the citation graph, returned as a cited pointer into the
record ("this happened on [date], per [note]") — closer to a very good Ctrl-F / museum
guide than a chatbot. Refuses/flags plainly when it can't find a source-backed answer.
"Haiku mode" is an optional compact response format.

## 4. Auth

*Superseded — see the note at the top of this doc.* Original plan, kept for history:

Cloudflare Access, same model as `suxdash`. v1: one shared test/dev identity for staging.
Per-recipient OAuth invites explicitly deferred — not blocking staging.

## 5. Staging plan (tonight)

1. Repo created (`SuxOS/suxos-net`, private), this design doc committed.
2. Minimal Worker skeleton: routes for the 2D navigator and QA stub, wired to `suxvault`
   (currently empty — safe).
3. Cloudflare Access staged with the user's own test identity — not a public route.
4. **Not done tonight, and shouldn't be:** real content population, per-recipient invites,
   live DNS cutover to `suxos.net`. Those happen together with the user.

## 6. Open dependency

`suxdash` (the sibling command-center Worker this reuses the BFF/Access pattern from) is
itself still local-only — no GitHub remote, not registered in the fabric, no pipeline
wiring. `suxos-net` is being scaffolded directly rather than through the autonomous
`issue-build` pipeline for this reason: a brand-new repo has no `issue-build.yml`/
`automerge.yml` yet, so the cloud loop has nothing to pick up until that wiring exists.
Wiring both repos into the pipeline is follow-up work, not tonight's blocker.

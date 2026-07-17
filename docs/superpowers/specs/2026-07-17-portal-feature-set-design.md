# Portal feature set — the provider-facing experience

Status: adopted 2026-07-17

What a signed-in recipient (a doctor, first) actually sees and does on portal.suxos.net.
The purpose is concrete: **demonstrate, from real evidence, that treatment helped — and
that the person presenting it is capable** — while never letting the AI layer overclaim.
Every feature below obeys the standing rails: the user's own records/words are TESTIMONY
(full-fidelity, any accurate terminology); everything the AI adds is HEDGED (confidence-
scored, "appears to…", never "wrong"/"proven"/"verified").

## Feature 1 — Chatbot Q&A (in flight: PR #34)
Ask a question → citation-constrained retrieval over suxvault → a cited, hedged answer or
an honest "I can't find that." Already built and tested; foundation for the rest.

## Feature 2 — Rich document view with adjustable verbosity
A citation or navigator entry opens the **actual source document** (a clinic letter, a
visit note, the medication record) rendered as rich, readable markdown — not a summary
standing in for it. The verbosity control governs the AI-generated **context around** the
source, never the source text itself:
- `bare` → just the source document.
- `paragraph` → source + a short AI orientation blurb.
- `narrative` → source + full contextual annotation layer (Feature 3).
The source text is always shown in full fidelity — verbosity never redacts or paraphrases
testimony, it only adds/removes AI scaffolding.

## Feature 3 — Contextual annotation layer ("add context to notes")
AI-generated, clearly-labeled, always-hedged annotations attached alongside (never inside)
a source document:
- **"Did you know"** — a relevant fact from elsewhere in the record that a reader of this
  document alone would miss (cites the related record).
- **"How it relates"** — links this document to related records (a later visit, the
  medication that followed, the incident it references) via real citations.
- **"Consider this"** — a measured framing note, always hedged, never a claim of fact.
Every annotation is visibly marked as AI-added context, carries a confidence signal, and
links its source. Annotations never alter or overwrite the testimony they annotate.

## Feature 4 — Tone / claim highlighting (inline, hedged)
Inline highlights over document text, in two strictly-bounded flavors:
- **Tone highlight** — "this phrase appears strongly worded" (e.g. a hostile line in a
  family email), so a reader weighs it appropriately. Descriptive, never judgmental.
- **Possible-inconsistency highlight** — "this appears inconsistent with [cited record]",
  confidence-scored, linking the record it seems to differ from. This uses the existing
  inconsistencyFlagger contract. It NEVER says a claim is "wrong" or "false," and it NEVER
  flags the user's own testimony as incorrect — it only surfaces where two cited records
  appear to differ, and lets the human judge.

## Feature 5 — Productivity & treatment-timeline statistics
A stats view built from REAL data only — this is the evidence exhibit, so fabricated or
cherry-picked numbers would defeat its purpose:
- **Medication timeline** (real, from records/health/Medications.md): Pitolisant 6/14/2026
  (narcolepsy), then the 7/6–7/30 regimen — plotted as milestones on a time axis.
- **Real activity series**: git commit authorship over time (327 commits authored in
  2026-07 across the SuxOS repos — real, dense, and coincident with the treatment window),
  plus vault-note-writing frequency drawn from the dated daily-notes archive (2022→2026)
  for a longer baseline.
- **"Built something cool" exhibit**: real system-scale counts — N repos, N functions, the
  autonomous pipeline — as concrete artifacts of capability.
- Interpretation stays hedged: the chart shows real activity annotated with real medication
  milestones; the causal claim ("the stimulants helped me build this") is presented as the
  USER'S testimony, not asserted by the chart. Data is real; the reading is the user's.

## Data-integrity rule for Feature 5 (hard)
Never invent, round-up, or cherry-pick a statistic to strengthen the story. If a metric
doesn't show a real signal, show it honestly or omit it — a doctor trusts real numbers and
distrusts a too-clean chart. Every number renders with its real source.

## Sequencing (why this can't be built today)
These features stack on the foundation currently in-flight — the rendered frontend (#27),
auth (#35), the QA chatbot (#34), and the not-yet-built /api → real-suxvault wiring. Building
them against that unmerged base would recreate the drift this org just eliminated. So: the
foundation merges first, /api gets wired to real suxvault data, THEN Features 2–5 build on
top — each as its own well-scoped issue through the cloud pipeline (drift-free), or a single
coherent frontend build in an isolated worktree. Deployment to portal.suxos.net is the last
step, behind the per-recipient login (#18/#35).

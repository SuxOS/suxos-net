# Real access + retrieval design (no-stub v1)

## Goal
Replace every stub on the real (non-demo) path with a genuinely working implementation:
per-individual real access, real retrieval-backed QA, a real rendered frontend, and a
durable per-person audit log. Nothing here is a placeholder — each piece must actually
work end-to-end before v1.0 closes.

## 1. Access — Cloudflare Access, per-individual real emails
- Each recipient (care team member, attorney, family member) is added as their own
  `include: {email: ...}` entry on the existing `portal.suxos.net` Access application
  policy (currently `operator-only`, single email).
- Same OTP login mechanism already live and proven for the operator.
- Cloudflare passes the authenticated identity (email) to the Worker via the
  `Cf-Access-Authenticated-User-Email` header (or JWT claim) on every request — this
  becomes the per-person identity for the audit log, at zero extra auth-system cost.
- No shared logins, no new username/password system. Real recipient emails must be
  supplied by the user before each person can log in — no self-serve invite flow in v1
  (rejected: adds token/expiry/acceptance-endpoint complexity for a benefit — self-serve
  invites — that doesn't apply when recipient emails are already known).

## 2. Retrieval — Vectorize + Workers AI embeddings
- suxvault's markdown notes (post-merge, real content) are chunked and embedded using a
  Workers AI embedding model, stored in a Cloudflare Vectorize index.
- A sync mechanism re-embeds changed/added notes when suxvault content changes (exact
  trigger — webhook on suxvault push vs. scheduled re-sync — is an implementation-plan
  decision, not a design-level one; either is acceptable as long as it's not manual).
- Each vector carries its source note path as metadata, so a retrieved chunk always maps
  back to a real citation.

## 3. QA answers — citation-constrained LLM synthesis
- Incoming question → embedded → top-k relevant chunks retrieved from Vectorize.
- An LLM call receives ONLY the retrieved chunks as context — never open/general
  knowledge, never a live fetch outside the retrieved set. This is a hard architectural
  constraint (the LLM call's context window contains nothing else), not a prompt-level
  request.
- The LLM is required to: answer conversationally, cite which retrieved chunk backs each
  claim (chunk → source note path), and explicitly say "I can't find that" when retrieval
  returns nothing sufficiently relevant (below a similarity threshold — exact threshold is
  an implementation detail to tune, not a design commitment).
- This satisfies the existing design rail: QA is pointer-routing, never freestanding.
  Fabrication is structurally blocked because the LLM cannot see anything but real,
  pre-retrieved suxvault content.
- AI-generated answers stay hedged per the existing inconsistencyFlagger contract —
  confidence-scored, "appears to say," never "wrong"/"verified"/"true" as bare assertions.

## 4. Frontend — real route, not just /demo
- The rendered navigator UI (already built in PR #27, currently only wired at `/demo`)
  gets a real counterpart at the root path (`/` or `/app` — implementation detail),
  wired to `/api/navigator` and the new real `/api/qa`.
- Same verbosity × time-scope crossed controls, same QA tab, same Flags tab — reusing
  PR #27's frontend code, pointed at real endpoints instead of demo ones.
- Real frontend only goes live once suxvault content is actually merged and wired — no
  point serving a real-feeling page over an empty backend.

## 5. Audit log — durable, per-individual
- Every navigator view and QA answer is logged: authenticated email (from Access),
  timestamp, route/query, and outcome (citation returned vs. not-found).
- Durable storage (KV or D1 — implementation-plan decision), replacing the current
  in-memory-per-isolate implementation (existing gap, tracked #20/#23).
- Read-only admin view of the log (already scoped in #20).

## 6. Trusted references — mechanism only, unchanged
- The curation mechanism (#19) is buildable now. The actual curated facts (drug
  interactions, legal standards) still require a human curator — this rail is
  independent of "no stubs elsewhere," since fabricating real clinical/legal facts is
  not something to automate regardless of how much trust is granted on infrastructure.

## Explicitly out of scope for this spec
- Self-serve invite/token flow for recipients (rejected above — not needed given known
  recipient emails).
- Real trusted-reference content authoring (separate, human-only workstream).
- Username/password auth as an alternative to Cloudflare Access (rejected — would
  duplicate what Access already does correctly, and weakens the existing gate rail
  unless run in addition to it, at which point there's no benefit).

## Dependencies / sequencing
1. suxvault PR #1 must merge (real content must exist before embedding it).
2. Vectorize index + embedding sync can be built in parallel against suxvault's current
   (pre-merge) content for testing, then re-synced once real content lands.
3. Real Access per-individual policies need the user to supply actual recipient emails —
   cannot be filled in generically.
4. Frontend real-route wiring depends on /api/qa and /api/navigator serving real data.
5. Durable audit log should land before real content goes live (currently in-memory,
   tracked #20/#23) — sequencing-sensitive, not optional-later.

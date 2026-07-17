# Real access + retrieval design (no-stub v1)

## Goal
Replace every stub on the real (non-demo) path with a genuinely working implementation:
per-individual real access, real retrieval-backed QA, a real rendered frontend, and a
durable per-person audit log. Nothing here is a placeholder — each piece must actually
work end-to-end before v1.0 closes.

## 1. Access — REVISED 2026-07-17: real username/password, per individual
Original plan (per-individual Cloudflare Access emails) assumed every recipient's real
email was known in advance. That assumption is false — the user doesn't have emails for
everyone who needs access. Per-individual Cloudflare Access policies require an email
identity per person, so that mechanism doesn't fully cover the real recipient set. Revised
design, still real, still per-individual, no stubs:

- **Cloudflare Access stays in place as the operator's own gate** (unchanged,
  `operator-only`, OTP) — this protects the Worker's admin/config surface.
- **A real username/password system is added for recipients**, built into the Worker:
  - Passwords hashed with a real KDF (PBKDF2-HMAC-SHA256 via WebCrypto, or scrypt if
    available in the Workers runtime — NOT a placeholder hash, NOT plaintext, NOT a
    reversible encoding). Per-user random salt, stored alongside the hash.
  - One real account per recipient (per-individual, not shared) — created by the operator
    (you set an initial username + password per person, out of band, e.g. told to them
    directly), not self-serve signup (no public registration surface for a portal holding
    this kind of content).
  - Session handling via a signed, HttpOnly, Secure session cookie (not a bearer token in
    localStorage — avoids XSS-exfiltration of the session). Real expiry, real signature
    verification (HMAC over a server-side secret), not a stub session.
  - Password storage in KV or D1 (durable, not in-memory) — same store class as the audit
    log (§5), so both durability requirements land together.
  - This login identity (the recipient's username) is what feeds the per-individual audit
    log (§5) — same accountability goal as the original email-based plan, achieved via a
    different identity source.
  - A basic password-reset path is needed (operator resets it directly for a recipient who
    forgets — no email-based reset flow, since email isn't the identity anchor here).
- Rejected: self-serve signup (no public registration for this content); storing
  passwords in plaintext or with a non-cryptographic hash (unacceptable for real health/
  legal data); reusing the Cloudflare Access mechanism for recipients (would require an
  email identity we don't have for everyone — the whole reason for this revision).

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
- Self-serve invite/token flow for recipients (rejected — no public registration for this
  content, regardless of access method).
- Real trusted-reference content authoring (separate, human-only workstream — but see
  suxos-net#19, now seeded with draft candidates awaiting the user's curation).
- Email-based password reset (rejected — email isn't the identity anchor for recipient
  accounts under the revised §1; operator resets directly instead).

## Revision log
- 2026-07-17: §1 revised from per-individual Cloudflare Access emails to real
  username/password, because the user does not have real emails for every recipient.
  The original per-individual-identity goal is unchanged — same accountability
  requirement, different identity source.

## Dependencies / sequencing
1. suxvault PR #1 must merge (real content must exist before embedding it).
2. Vectorize index + embedding sync can be built in parallel against suxvault's current
   (pre-merge) content for testing, then re-synced once real content lands.
3. Real Access per-individual policies need the user to supply actual recipient emails —
   cannot be filled in generically.
4. Frontend real-route wiring depends on /api/qa and /api/navigator serving real data.
5. Durable audit log should land before real content goes live (currently in-memory,
   tracked #20/#23) — sequencing-sensitive, not optional-later.

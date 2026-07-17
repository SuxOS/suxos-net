// Generic candidate-inconsistency detector over abstract structured claims — not any
// real personal content. Operates on `{ id, text, citations, confidence? }[]` and is
// deliberately dumb: a keyword-overlap + negation-marker heuristic, not NLP. See the
// TODO below for what a real implementation needs.

export interface Claim {
	id: string;
	text: string;
	citations: string[];
	confidence?: number;
}

/**
 * A candidate inconsistency between two claims, surfaced for human review.
 *
 * `relation` is `"precedesConflictWith"` when either claim text carries an explicit
 * temporal/ordering marker (e.g. "before", "after", "then") alongside the detected
 * polarity conflict, and `"appearsInconsistentWith"` otherwise. Either way this is a
 * pattern match, not a judgment — see the TSDoc on {@link findInconsistencies}.
 */
export interface InconsistencyFlag {
	claimIdA: string;
	claimIdB: string;
	relation: "appearsInconsistentWith" | "precedesConflictWith";
	/** Always strictly less than 1 — this heuristic never claims certainty. */
	confidence: number;
	note: string;
}

const STOPWORDS = new Set([
	"the", "a", "an", "and", "or", "but", "is", "was", "were", "are", "be", "been",
	"being", "to", "of", "in", "on", "at", "for", "with", "as", "by", "that", "this",
	"it", "its", "from", "has", "have", "had", "not", "no", "never", "n't", "did",
	"does", "do", "will", "would", "can", "could", "should", "then", "before",
	"after", "was", "were", "than",
]);

const NEGATION_MARKERS = [
	"not", "no", "never", "without", "aren't", "weren't", "cannot", "false", "denies",
	"denied", "refutes", "refuted",
];

// Any "...n't" contraction (isn't, doesn't, didn't, won't, can't, shouldn't, hasn't, ...) is a
// negation. Matched separately from NEGATION_MARKERS/matchesAnyMarker below because "n't" is
// inherently a suffix glued onto a preceding word — it never has a word boundary before the
// "n", so a plain `\bn't\b` marker can never match a real contraction.
const NEGATION_CONTRACTION_RE = /\b[a-z]+n't\b/;

const TEMPORAL_MARKERS = ["before", "after", "then", "prior to", "later", "subsequently", "preceded", "followed"];

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9']+/)
		.filter((word) => word.length > 2 && !STOPWORDS.has(word));
}

function sharedSignificantTerms(a: string[], b: string[]): string[] {
	const bSet = new Set(b);
	return [...new Set(a)].filter((word) => bSet.has(word));
}

// Word-boundary matching, not raw substring — markers include short strings like "no"
// and "after" that would otherwise false-match inside unrelated words ("now", "diagnosis",
// "afternoon"). `\b` is ASCII-word-boundary aware, which is exactly what we want for these
// English markers; multi-word markers like "prior to" still match across their own spaces.
function matchesAnyMarker(text: string, markers: string[]): boolean {
	const lower = text.toLowerCase();
	return markers.some((marker) => new RegExp(`\\b${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(lower));
}

function hasNegation(text: string): boolean {
	return NEGATION_CONTRACTION_RE.test(text.toLowerCase()) || matchesAnyMarker(text, NEGATION_MARKERS);
}

function hasTemporalMarker(text: string): boolean {
	return matchesAnyMarker(text, TEMPORAL_MARKERS);
}

const NOTE_TEMPLATE = (a: string, b: string) =>
	`Claim ${a} and claim ${b} appear inconsistent — cite both and let the reader judge.`;

/**
 * A candidate positive-corroboration signal for a single claim: it has multiple
 * independent citations and no detected conflict, so it's a reasonable one to
 * hand a reviewer as "well-supported" — never as "true". See the TSDoc on
 * {@link findGroundingSignals} for the non-negotiable wording contract.
 */
export interface GroundingSignal {
	claimId: string;
	/** Citation ids this signal is grounded in — always the claim's own citations. */
	groundedBy: string[];
	/** Always strictly less than 1 — corroboration by citation count is not proof. */
	confidence: number;
	note: string;
}

const GROUNDING_NOTE_TEMPLATE = (id: string, citationCount: number) =>
	`Claim ${id} is supported by ${citationCount} independent citations, with no conflicting claims detected — still worth the reader's own check.`;

/**
 * Surface *candidate* logical inconsistencies between pairs of claims, for a human
 * reviewer to weigh — never a conclusion this function reaches itself.
 *
 * NON-NEGOTIABLE CONTRACT for every value this function returns:
 * - It is never an assertion of fact, a diagnosis, or a statement that any claim is
 *   correct, incorrect, true, false, lying, or mistaken. It does not decide who (if
 *   anyone) is right.
 * - Every flag uses hedged, pattern-based language only (`appearsInconsistentWith`,
 *   `precedesConflictWith`), a `confidence` that is always `< 1` (never certainty),
 *   and a neutral `note` that hands the decision to a human reader.
 * - Callers must not upgrade this output into a stronger claim (e.g. rendering it as
 *   "X is wrong" in UI copy) — that would violate the reason this function exists.
 *
 * Implementation is an honest, simple heuristic: shared-keyword overlap between two
 * claims' text, plus a check for negation-marker asymmetry (one claim negates, the
 * other doesn't, over the same shared terms) as a proxy for polarity conflict.
 *
 * TODO: this is NOT real natural-language understanding. A production version needs
 * proper NLP/textual-entailment checking (e.g. an entailment/contradiction classifier)
 * to catch conflicts that don't share surface keywords, or to avoid false positives
 * where negation appears but isn't actually about the shared claim. If an LLM-assisted
 * variant is wanted later, that must be a separate, explicitly-documented function —
 * this one stays deterministic, offline, and testable.
 */
export function findInconsistencies(claims: Claim[]): InconsistencyFlag[] {
	const flags: InconsistencyFlag[] = [];

	for (let i = 0; i < claims.length; i++) {
		for (let j = i + 1; j < claims.length; j++) {
			const a = claims[i];
			const b = claims[j];

			const tokensA = tokenize(a.text);
			const tokensB = tokenize(b.text);
			const shared = sharedSignificantTerms(tokensA, tokensB);

			if (shared.length < 2) continue;

			const negationA = hasNegation(a.text);
			const negationB = hasNegation(b.text);
			const polarityAsymmetry = negationA !== negationB;

			if (!polarityAsymmetry) continue;

			const temporal = hasTemporalMarker(a.text) || hasTemporalMarker(b.text);
			const relation: InconsistencyFlag["relation"] = temporal ? "precedesConflictWith" : "appearsInconsistentWith";

			const overlapBoost = Math.min(shared.length, 5) * 0.08;
			const confidence = Math.min(0.35 + overlapBoost, 0.85);

			flags.push({
				claimIdA: a.id,
				claimIdB: b.id,
				relation,
				confidence,
				note: NOTE_TEMPLATE(a.id, b.id),
			});
		}
	}

	return flags;
}

/**
 * Surface *candidate* positive-corroboration signals — the complementary green-flag
 * counterpart to {@link findInconsistencies}. Both are the same neutral instrument
 * applied in two directions: one surfaces claims worth a reviewer's extra scrutiny,
 * the other surfaces claims that already have multiple independent citations and no
 * detected conflict, so a reviewer doesn't have to re-derive that from scratch.
 *
 * NON-NEGOTIABLE CONTRACT, same standard as {@link findInconsistencies}:
 * - This NEVER asserts a claim is true, verified, confirmed, or valid. It only
 *   reports that the claim is *corroborated* — backed by multiple independent
 *   citations with no conflict detected against it. Citation count is a proxy for
 *   "worth less extra scrutiny," not a proxy for truth, and callers must not blur
 *   that line in any UI copy built on top of this.
 * - `confidence` is always `< 1`.
 * - `groundedBy` cites exactly what the signal is grounded in (the claim's own
 *   citation ids) so a reviewer can go check them.
 *
 * Heuristic: a claim gets a grounding signal when it has 2 or more distinct
 * citations AND does not appear (on either side) in any flag from
 * `findInconsistencies`. That's it — this does not weigh citation quality,
 * independence of sources, or recency.
 *
 * TODO: real corroboration strength needs source-independence and reliability
 * weighting (two citations to the same underlying document aren't independent
 * corroboration), not just a raw citation count. Future work, not this heuristic.
 */
export function findGroundingSignals(claims: Claim[]): GroundingSignal[] {
	const flags = findInconsistencies(claims);
	const flaggedClaimIds = new Set<string>();
	for (const flag of flags) {
		flaggedClaimIds.add(flag.claimIdA);
		flaggedClaimIds.add(flag.claimIdB);
	}

	const signals: GroundingSignal[] = [];
	for (const claim of claims) {
		if (flaggedClaimIds.has(claim.id)) continue;

		const distinctCitations = [...new Set(claim.citations)];
		if (distinctCitations.length < 2) continue;

		const confidence = Math.min(0.4 + Math.min(distinctCitations.length, 5) * 0.08, 0.85);

		signals.push({
			claimId: claim.id,
			groundedBy: distinctCitations,
			confidence,
			note: GROUNDING_NOTE_TEMPLATE(claim.id, distinctCitations.length),
		});
	}

	return signals;
}

/**
 * A single, explicitly human-curated trusted reference — the fixed comparison set
 * for {@link flagAgainstReferences}. This is deliberately NOT the tool pulling from
 * general or academic knowledge at runtime: it is a small, hand-vetted bibliography
 * that a human builds and adds to explicitly, so every reference-consistency flag is
 * traceable to one specific, named, vetted source rather than an open-ended lookup.
 */
export interface TrustedReference {
	id: string;
	text: string;
	source: string;
	sourceUrl?: string;
}

/**
 * A candidate inconsistency between a claim and a curated trusted reference. Same
 * hedged-language contract as {@link InconsistencyFlag} — see the TSDoc on
 * {@link flagAgainstReferences}.
 */
export interface ReferenceInconsistencyFlag {
	claimId: string;
	appearsInconsistentWith: string;
	/** Always strictly less than 1 — this heuristic never claims certainty. */
	confidence: number;
	note: string;
}

const REFERENCE_NOTE_TEMPLATE = (claimId: string, referenceId: string, source: string) =>
	`Claim ${claimId} appears inconsistent with reference ${referenceId} (${source}) — cite both and let the reader judge.`;

/**
 * Surface *candidate* inconsistencies between claims and a small, explicitly
 * human-curated set of trusted references — the reference-consistency counterpart to
 * {@link findInconsistencies}'s self-consistency pass (claim vs. other claims in the
 * same record). Same neutral instrument, compared against a different, fixed source.
 *
 * `references` is intentionally never auto-populated from open/general knowledge at
 * runtime — sourcing every comparison from an ungated lookup would undercut the whole
 * "bounded, measured claims" design principle this tool exists to enforce. Callers are
 * expected to pass in a small, explicitly vetted bibliography (like `TrustedReference`
 * fixtures a human reviewed and added on purpose), not a live search result.
 *
 * NON-NEGOTIABLE CONTRACT, same standard as {@link findInconsistencies}:
 * - Never an assertion that the claim or the reference is true, false, verified,
 *   confirmed, valid, wrong, lying, or mistaken. It does not decide which one (if
 *   either) is right.
 * - `confidence` is always `< 1`.
 * - `note` is neutral, hands the decision to a human reader, and always names the
 *   specific reference (`source`) so it can be checked.
 *
 * Implementation is the same heuristic tier as {@link findInconsistencies}: naive
 * shared-keyword overlap plus negation-marker asymmetry — not real NLP.
 *
 * TODO: this is NOT textual entailment. A production version needs a real
 * entailment/contradiction classifier to catch conflicts that don't share surface
 * keywords (e.g. a claim and a reference using different terms for the same
 * mechanism), and to avoid false positives where negation is present but isn't
 * actually about the shared subject. Same "no LLM calls here" constraint as the
 * self-consistency pass — an LLM-assisted variant is separate, future, documented
 * work, not this function.
 */
export function flagAgainstReferences(claims: Claim[], references: TrustedReference[]): ReferenceInconsistencyFlag[] {
	const flags: ReferenceInconsistencyFlag[] = [];

	for (const claim of claims) {
		const claimTokens = tokenize(claim.text);
		const claimNegation = hasNegation(claim.text);

		for (const reference of references) {
			const referenceTokens = tokenize(reference.text);
			const shared = sharedSignificantTerms(claimTokens, referenceTokens);

			if (shared.length < 2) continue;

			const referenceNegation = hasNegation(reference.text);
			if (claimNegation === referenceNegation) continue;

			const overlapBoost = Math.min(shared.length, 5) * 0.08;
			const confidence = Math.min(0.35 + overlapBoost, 0.85);

			flags.push({
				claimId: claim.id,
				appearsInconsistentWith: reference.id,
				confidence,
				note: REFERENCE_NOTE_TEMPLATE(claim.id, reference.id, reference.source),
			});
		}
	}

	return flags;
}

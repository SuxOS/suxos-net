// Reviewer-facing record-integrity pass (design doc §1: "never ask a reader to take
// the user's word for it"). Wires the four already-built, tested pure tools in
// src/tools/ — findInconsistencies, findGroundingSignals, flagAgainstReferences,
// checkCitationIntegrity — into a single response, so a reviewer (a doctor checking
// their reasoning is well-supported, an attorney looking closer at a red flag) gets
// hedged inconsistency flags, corroboration signals, and a dangling-citation report in
// one call instead of these tools staying dead-ended behind their own test suites.

import { checkCitationIntegrity, type CitationIntegrityReport } from "./tools/citationIntegrity";
import {
	findGroundingSignals,
	findInconsistencies,
	flagAgainstReferences,
	type Claim,
	type GroundingSignal,
	type InconsistencyFlag,
	type ReferenceInconsistencyFlag,
	type TrustedReference,
} from "./tools/inconsistencyFlagger";

export interface ReviewRequest {
	claims: Claim[];
	/** Optional hand-curated bibliography — see TrustedReference's own contract. */
	references?: TrustedReference[];
	/**
	 * The authoritative set of citation ids to check every claim's citations against.
	 * Omitted rather than defaulted: with suxvault currently empty there is no real
	 * citation authority this Worker can safely assume, so the caller supplies it
	 * explicitly. When omitted, citation-integrity checking is skipped entirely
	 * (`citationIntegrity: null`) rather than silently defaulting to "everything
	 * dangling" or "everything clean" — either default would be a fabricated result.
	 */
	knownCitationIds?: string[];
}

export interface ReviewResponse {
	inconsistencies: InconsistencyFlag[];
	groundingSignals: GroundingSignal[];
	referenceFlags: ReferenceInconsistencyFlag[];
	citationIntegrity: CitationIntegrityReport | null;
	claimsChecked: number;
	generatedAt: string;
}

/**
 * Pure aggregation over the four tools — no I/O, no fabricated defaults. Every field
 * in the response is exactly what its underlying tool produced; this function adds no
 * interpretation of its own.
 */
export function runReview(request: ReviewRequest): ReviewResponse {
	const { claims, references = [], knownCitationIds } = request;

	return {
		inconsistencies: findInconsistencies(claims),
		groundingSignals: findGroundingSignals(claims),
		referenceFlags: flagAgainstReferences(claims, references),
		citationIntegrity: knownCitationIds ? checkCitationIntegrity(claims, knownCitationIds) : null,
		claimsChecked: claims.length,
		generatedAt: new Date().toISOString(),
	};
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

export function isClaim(value: unknown): value is Claim {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	if (!isNonEmptyString(v.id)) return false;
	if (typeof v.text !== "string") return false;
	if (!Array.isArray(v.citations) || !v.citations.every((c) => typeof c === "string")) return false;
	if (v.confidence !== undefined && typeof v.confidence !== "number") return false;
	return true;
}

export function isTrustedReference(value: unknown): value is TrustedReference {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	if (!isNonEmptyString(v.id)) return false;
	if (typeof v.text !== "string") return false;
	if (typeof v.source !== "string") return false;
	if (v.sourceUrl !== undefined && typeof v.sourceUrl !== "string") return false;
	return true;
}

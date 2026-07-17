// Demo-only inline highlight view (design doc §Feature 4) — tone highlights over the
// fictional testimony documents, plus possible-inconsistency highlights over the
// fictional claims, for the /demo/highlights route. Not real content — see
// demoData.ts's top-of-file disclaimer.
//
// HARD RAIL, enforced structurally rather than by convention: tone highlighting runs
// only over demoTestimonyDocuments, and inconsistency highlighting runs only over
// demoClaims/demoTestimonyForReferenceCheck (never over demoTestimonyDocuments) — so a
// testimony document can never receive a possible-inconsistency ("this claim appears
// incorrect") highlight, only a tone highlight. See docs/superpowers/specs/
// 2026-07-17-portal-feature-set-design.md §Feature 4.

import { findToneHighlights } from "../tools/toneHighlighter";
import { findInconsistencies, flagAgainstReferences } from "../tools/inconsistencyFlagger";
import { demoTestimonyDocuments, demoClaimsForReferenceCheck, demoClaims, demoTrustedReferences } from "./demoData";

const NOTICE = "FICTIONAL DEMO DATA — not the user's real information. Do not treat as real.";

export interface DemoToneHighlight {
	type: "tone";
	sourceId: string;
	matchedMarkers: string[];
	confidence: number;
	note: string;
}

export interface DemoInconsistencyHighlight {
	type: "possible-inconsistency";
	sourceId: string;
	relatedId: string;
	confidence: number;
	note: string;
}

export type DemoHighlight = DemoToneHighlight | DemoInconsistencyHighlight;

export interface DemoHighlightsResponse {
	highlights: DemoHighlight[];
	notice: string;
}

export function buildDemoHighlightsView(): DemoHighlightsResponse {
	const toneHighlights: DemoToneHighlight[] = findToneHighlights(demoTestimonyDocuments).map((h) => ({
		type: "tone",
		sourceId: h.sourceId,
		matchedMarkers: h.matchedMarkers,
		confidence: h.confidence,
		note: h.note,
	}));

	const selfConsistencyHighlights: DemoInconsistencyHighlight[] = findInconsistencies(demoClaims).map((f) => ({
		type: "possible-inconsistency",
		sourceId: f.claimIdA,
		relatedId: f.claimIdB,
		confidence: f.confidence,
		note: f.note,
	}));

	const referenceHighlights: DemoInconsistencyHighlight[] = flagAgainstReferences(
		demoClaimsForReferenceCheck,
		demoTrustedReferences,
	).map((f) => ({
		type: "possible-inconsistency",
		sourceId: f.claimId,
		relatedId: f.appearsInconsistentWith,
		confidence: f.confidence,
		note: f.note,
	}));

	return {
		highlights: [...toneHighlights, ...selfConsistencyHighlights, ...referenceHighlights],
		notice: NOTICE,
	};
}

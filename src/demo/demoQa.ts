// Demo-only QA — simple keyword-match retrieval over demoData.ts's fictional records
// and claims, to demonstrate the "pointer, not chat" concept (design doc §3) with a
// real cited answer instead of the bare /api/qa stub. Grep-shaped, not an LLM call:
// no fabrication is possible here, only "here's what matched, with its citations."

import { demoClaims, demoRecords } from "./demoData";
import { toOneLine } from "../tools/verbositySummarizer";

export interface DemoQaMatch {
	id: string;
	date?: string;
	text: string;
	citations: string[];
}

/** "Haiku mode" (design doc §3): an opt-in compact rendering of the same cited
 * matches, not a different answer — see `askDemoQuestion`'s `format` param. */
export type QaFormat = "default" | "haiku";

export interface DemoQaResponse {
	question: string;
	matches: DemoQaMatch[];
	status: "matched" | "no_match";
	notice: string;
	format: QaFormat;
}

const NOTICE = "FICTIONAL DEMO DATA — not the user's real information. Do not treat as real.";

const STOPWORDS = new Set([
	"the", "a", "an", "and", "or", "but", "is", "was", "were", "are", "be", "been",
	"to", "of", "in", "on", "at", "for", "with", "as", "by", "that", "this", "did",
	"what", "when", "where", "who", "how", "does", "do", "has", "have", "had",
]);

function keywordsOf(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9']+/)
		.filter((word) => word.length > 2 && !STOPWORDS.has(word));
}

/**
 * Keyword-overlap retrieval over the demo dataset's records and claims. Every match
 * returned carries its own citations, unchanged — this function never invents an
 * answer or a citation, it only surfaces records/claims whose text shares keywords
 * with the question, ranked by overlap count.
 */
export function askDemoQuestion(question: string, format: QaFormat = "default"): DemoQaResponse {
	const questionKeywords = new Set(keywordsOf(question));

	const candidates: DemoQaMatch[] = [
		...demoRecords.map((r) => ({ id: r.id, date: r.date, text: r.text, citations: r.citations })),
		...demoClaims.map((c) => ({ id: c.id, text: c.text, citations: c.citations })),
	];

	const scored = candidates
		.map((candidate) => {
			const overlap = keywordsOf(candidate.text).filter((word) => questionKeywords.has(word)).length;
			return { candidate, overlap };
		})
		.filter(({ overlap }) => overlap > 0)
		.sort((a, b) => b.overlap - a.overlap)
		.slice(0, 5)
		.map(({ candidate }) => candidate);

	// Haiku mode compacts each match's text to a single line via the same
	// oneline-verbosity transform navigator.ts uses — citations are untouched, so
	// it only shortens the rendering, never drops or fabricates a source.
	const matches = format === "haiku" ? scored.map((match) => ({ ...match, text: toOneLine(match.text) })) : scored;

	return {
		question,
		matches,
		status: matches.length > 0 ? "matched" : "no_match",
		notice: NOTICE,
		format,
	};
}

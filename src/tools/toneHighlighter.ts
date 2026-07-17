// Generic candidate-tone-highlight detector over abstract structured sources — not any
// real personal content. Operates on `{ id, text }[]` and is deliberately dumb: a
// curated strong-language marker list, not NLP or sentiment analysis.

export interface ToneSource {
	id: string;
	text: string;
}

/**
 * A candidate "this phrase appears strongly worded" highlight, surfaced for a human
 * reader to weigh — never a judgment about the source itself.
 *
 * NON-NEGOTIABLE CONTRACT for every value this function returns:
 * - Descriptive only ("appears strongly worded"), never judgmental — it never says a
 *   source is angry, hostile, unreliable, wrong, or lying.
 * - `confidence` is always strictly less than `1`.
 * - `matchedMarkers` names the specific words that triggered the highlight, so a
 *   reader can see exactly why and disagree.
 */
export interface ToneHighlight {
	sourceId: string;
	matchedMarkers: string[];
	/** Always strictly less than 1 — this heuristic never claims certainty. */
	confidence: number;
	note: string;
}

// A small, curated list of intensifier/absolutist/hostile-register words. Deliberately
// narrow — false negatives (missing a strongly-worded phrase) are far preferable here to
// false positives that mislabel ordinary text as "strong."
const STRONG_MARKERS = [
	"furious", "outrageous", "unacceptable", "disgusted", "refuse", "refuses", "refused",
	"demand", "demands", "demanded", "insist", "insists", "insisted", "never", "always",
	"absolutely", "completely", "totally", "ridiculous", "disgraceful", "appalling",
	"livid", "enraged", "hostile", "threatening", "threatened",
];

function matchedMarkersIn(text: string): string[] {
	const lower = text.toLowerCase();
	return STRONG_MARKERS.filter((marker) => new RegExp(`\\b${marker}\\b`).test(lower));
}

const NOTE_TEMPLATE = (id: string, markers: string[]) =>
	`Source ${id} appears strongly worded (${markers.join(", ")}) — noted so the reader can weigh tone, not a judgment about the writer.`;

/**
 * Surface *candidate* tone highlights — spans of text that use intensifier/absolutist/
 * hostile-register language, for a human reader to weigh. Never a conclusion this
 * function reaches itself, and never an assertion that the source or its author is
 * angry, wrong, or unreliable.
 *
 * TODO: this is a keyword marker list, not real sentiment/register analysis. A
 * production version needs proper NLP to catch strongly-worded phrasing that doesn't
 * use one of these specific words, and to avoid false positives where a marker word
 * appears but the surrounding register is neutral (e.g. "never" in "I have never been
 * happier"). Same "no LLM calls here" constraint as inconsistencyFlagger.ts — an
 * LLM-assisted variant is separate, future, documented work, not this heuristic.
 */
export function findToneHighlights(sources: ToneSource[]): ToneHighlight[] {
	const highlights: ToneHighlight[] = [];

	for (const source of sources) {
		const markers = matchedMarkersIn(source.text);
		if (markers.length === 0) continue;

		const confidence = Math.min(0.35 + Math.min(markers.length, 5) * 0.08, 0.85);

		highlights.push({
			sourceId: source.id,
			matchedMarkers: markers,
			confidence,
			note: NOTE_TEMPLATE(source.id, markers),
		});
	}

	return highlights;
}

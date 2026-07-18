// Generic verbosity-axis renderer (design doc §2). Operates on abstract structured
// records — not on any real personal content. `navigator.ts` is one caller of this;
// any future surface that needs a "render at requested detail level" behavior over
// dated, cited records should reuse this instead of re-deriving the logic.
//
// Pure function, no I/O, no fabrication: it only ever reshapes the `text` the caller
// already supplied. It never invents summary text that isn't derived from the input.

export type Verbosity = "bare" | "oneline" | "paragraph" | "full";

export const VERBOSITY_LEVELS: readonly Verbosity[] = ["bare", "oneline", "paragraph", "full"];

export interface StructuredRecord {
	id: string;
	date: string;
	text: string;
	citations: string[];
}

export interface RenderedRecord extends StructuredRecord {
	/** The record's text as rendered at the requested verbosity. `null` at "bare",
	 * where only id/date/citations are meaningful and no text is shown at all. */
	rendered: string | null;
}

const ONELINE_MAX_LENGTH = 140;

/**
 * Collapse `text` to a single line suitable for the "oneline" verbosity: the first
 * sentence if one is found within the length budget, otherwise a hard truncation
 * with an ellipsis. This is a display transform only — it never drops information
 * that changes the substance of the claim, just the amount of it shown at once.
 */
export function toOneLine(text: string): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (collapsed.length === 0) return "";

	const firstSentenceMatch = collapsed.match(/^.*?[.!?](?:\s|$)/);
	const candidate = firstSentenceMatch ? firstSentenceMatch[0].trim() : collapsed;

	if (candidate.length <= ONELINE_MAX_LENGTH) return candidate;
	return `${collapsed.slice(0, ONELINE_MAX_LENGTH - 1).trimEnd()}…`;
}

/**
 * Render an array of structured records at a requested verbosity level.
 *
 * - `bare`: no text at all (`rendered: null`) — id/date/citations only.
 * - `oneline`: a single collapsed line derived from `text`.
 * - `paragraph` / `full`: `text` unchanged. This module doesn't distinguish a
 *   richer "full narrative" from "paragraph" itself — a caller with a genuinely
 *   longer full-detail representation (e.g. a separate narrative field) should
 *   pass that in as `text` when rendering at `full`, or extend this function
 *   rather than special-case it at the call site.
 *
 * Pure and synchronous: does not fetch, mutate, or call out anywhere.
 */
export function summarizeAtVerbosity(records: StructuredRecord[], verbosity: Verbosity): RenderedRecord[] {
	return records.map((record) => {
		if (verbosity === "bare") return { ...record, rendered: null };
		if (verbosity === "oneline") return { ...record, rendered: toOneLine(record.text) };
		return { ...record, rendered: record.text };
	});
}

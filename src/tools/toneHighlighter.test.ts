import { describe, expect, it } from "vitest";
import { findToneHighlights, type ToneSource } from "./toneHighlighter";

const STRONGLY_WORDED: ToneSource = {
	id: "source-a",
	text: "This is absolutely unacceptable and I demand it be fixed immediately.",
};

const NEUTRAL: ToneSource = {
	id: "source-b",
	text: "The sample facility visit occurred on the test date as scheduled.",
};

const FORBIDDEN_WORDS = ["wrong", "false", "verified", "lying", "lied"];

describe("findToneHighlights", () => {
	it("flags a strongly-worded source with the specific markers matched", () => {
		const result = findToneHighlights([STRONGLY_WORDED]);
		expect(result).toHaveLength(1);
		expect(result[0].sourceId).toBe("source-a");
		expect(result[0].matchedMarkers).toEqual(expect.arrayContaining(["absolutely", "unacceptable", "demand"]));
	});

	it("does not flag neutral text", () => {
		expect(findToneHighlights([NEUTRAL])).toEqual([]);
	});

	it("never claims certainty", () => {
		const result = findToneHighlights([STRONGLY_WORDED]);
		expect(result[0].confidence).toBeLessThan(1);
	});

	it("never uses forbidden assertive/judgmental language in its note", () => {
		const result = findToneHighlights([STRONGLY_WORDED]);
		for (const highlight of result) {
			const lower = highlight.note.toLowerCase();
			for (const forbidden of FORBIDDEN_WORDS) {
				expect(lower).not.toContain(forbidden);
			}
		}
	});
});

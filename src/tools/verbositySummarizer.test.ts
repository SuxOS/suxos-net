import { describe, expect, it } from "vitest";
import { summarizeAtVerbosity, VERBOSITY_LEVELS, type StructuredRecord } from "./verbositySummarizer";

// Clearly-synthetic fixtures — not real content.
const RECORDS: StructuredRecord[] = [
	{
		id: "rec-001",
		date: "2026-02-01",
		text: "Sample event alpha happened. It involved a synthetic widget and a synthetic gadget. Nothing about it is real.",
		citations: ["cite-a", "cite-b"],
	},
	{
		id: "rec-002",
		date: "2026-02-02",
		text: "Sample event beta was a short one.",
		citations: ["cite-c"],
	},
];

describe("summarizeAtVerbosity", () => {
	it("renders every declared verbosity level without throwing", () => {
		for (const level of VERBOSITY_LEVELS) {
			expect(() => summarizeAtVerbosity(RECORDS, level)).not.toThrow();
		}
	});

	it("renders bare with no text at all", () => {
		const result = summarizeAtVerbosity(RECORDS, "bare");
		expect(result.every((r) => r.rendered === null)).toBe(true);
	});

	it("renders oneline as a single collapsed line shorter than the source", () => {
		const result = summarizeAtVerbosity(RECORDS, "oneline");
		for (const rendered of result) {
			expect(rendered.rendered).not.toBeNull();
			expect(rendered.rendered!.includes("\n")).toBe(false);
		}
		// The long multi-sentence record should be shortened at oneline.
		const long = result.find((r) => r.id === "rec-001")!;
		expect(long.rendered!.length).toBeLessThan(RECORDS[0].text.length);
	});

	it("renders paragraph and full with the full text, and distinctly from bare/oneline", () => {
		const paragraph = summarizeAtVerbosity(RECORDS, "paragraph");
		const full = summarizeAtVerbosity(RECORDS, "full");
		const bare = summarizeAtVerbosity(RECORDS, "bare");
		const oneline = summarizeAtVerbosity(RECORDS, "oneline");

		for (let i = 0; i < RECORDS.length; i++) {
			expect(paragraph[i].rendered).toBe(RECORDS[i].text);
			expect(full[i].rendered).toBe(RECORDS[i].text);
			expect(paragraph[i].rendered).not.toBe(bare[i].rendered);
		}
		// The long multi-sentence record is genuinely shortened at oneline, so
		// paragraph/full render distinctly from it there.
		const longIndex = RECORDS.findIndex((r) => r.id === "rec-001");
		expect(paragraph[longIndex].rendered).not.toBe(oneline[longIndex].rendered);
	});

	it("preserves id, date, and citations unchanged at every level", () => {
		for (const level of VERBOSITY_LEVELS) {
			const result = summarizeAtVerbosity(RECORDS, level);
			for (let i = 0; i < RECORDS.length; i++) {
				expect(result[i].id).toBe(RECORDS[i].id);
				expect(result[i].date).toBe(RECORDS[i].date);
				expect(result[i].citations).toEqual(RECORDS[i].citations);
			}
		}
	});
});

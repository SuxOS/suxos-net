import { describe, expect, it } from "vitest";
import { checkCitationIntegrity, type CitationBearingRecord } from "./citationIntegrity";

// Clearly-synthetic fixtures — not real content.
const KNOWN_CITATIONS = ["cite-1", "cite-2", "cite-3"];

describe("checkCitationIntegrity", () => {
	it("passes clean when every citation resolves to a known id (citations field)", () => {
		const records: CitationBearingRecord[] = [
			{ id: "claim-a", citations: ["cite-1", "cite-2"] },
			{ id: "claim-b", citations: ["cite-3"] },
		];
		const report = checkCitationIntegrity(records, KNOWN_CITATIONS);
		expect(report.clean).toBe(true);
		expect(report.dangling).toEqual([]);
		expect(report.recordsChecked).toBe(2);
		expect(report.citationReferencesChecked).toBe(3);
	});

	it("passes clean when every citation resolves to a known id (citationIds field)", () => {
		const records: CitationBearingRecord[] = [{ id: "entry-a", citationIds: ["cite-1"] }];
		const report = checkCitationIntegrity(records, KNOWN_CITATIONS);
		expect(report.clean).toBe(true);
	});

	it("flags a dangling citation id not present in the known set", () => {
		const records: CitationBearingRecord[] = [
			{ id: "claim-a", citations: ["cite-1", "cite-does-not-exist"] },
		];
		const report = checkCitationIntegrity(records, KNOWN_CITATIONS);
		expect(report.clean).toBe(false);
		expect(report.dangling).toEqual([{ recordId: "claim-a", citationId: "cite-does-not-exist" }]);
	});

	it("flags multiple dangling citations across multiple records, in order", () => {
		const records: CitationBearingRecord[] = [
			{ id: "claim-a", citations: ["cite-missing-1"] },
			{ id: "claim-b", citations: ["cite-2"] },
			{ id: "claim-c", citationIds: ["cite-missing-2"] },
		];
		const report = checkCitationIntegrity(records, KNOWN_CITATIONS);
		expect(report.dangling).toEqual([
			{ recordId: "claim-a", citationId: "cite-missing-1" },
			{ recordId: "claim-c", citationId: "cite-missing-2" },
		]);
		expect(report.citationReferencesChecked).toBe(3);
	});

	it("treats a record with no citations as trivially clean", () => {
		const records: CitationBearingRecord[] = [{ id: "claim-a", citations: [] }];
		const report = checkCitationIntegrity(records, KNOWN_CITATIONS);
		expect(report.clean).toBe(true);
		expect(report.citationReferencesChecked).toBe(0);
	});

	it("handles an empty records array", () => {
		const report = checkCitationIntegrity([], KNOWN_CITATIONS);
		expect(report.clean).toBe(true);
		expect(report.recordsChecked).toBe(0);
	});
});

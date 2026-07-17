import { describe, expect, it } from "vitest";
import { isClaim, isTrustedReference, runReview } from "./review";
import type { Claim, TrustedReference } from "./tools/inconsistencyFlagger";

// Clearly-synthetic fixtures — not real content, not real people.
const CONFLICTING_PAIR: Claim[] = [
	{
		id: "claim-a",
		text: "The synthetic widget was present at the sample facility on the test date.",
		citations: ["cite-1"],
	},
	{
		id: "claim-b",
		text: "The synthetic widget was not present at the sample facility on the test date.",
		citations: ["cite-2"],
	},
];

const GROUNDED_CLAIM: Claim = {
	id: "claim-d",
	text: "Sample event gamma occurred at the fictional annex during the fictional quarter.",
	citations: ["cite-4", "cite-5"],
};

const REFERENCE: TrustedReference = {
	id: "ref-1",
	text: "The synthetic widget was not present at the sample facility on the test date.",
	source: "Fictional Reference Manual",
};

describe("runReview", () => {
	it("aggregates inconsistencies, grounding signals, and reference flags over the given claims", () => {
		const result = runReview({ claims: [...CONFLICTING_PAIR, GROUNDED_CLAIM] });
		expect(result.inconsistencies.length).toBeGreaterThan(0);
		expect(result.groundingSignals.some((s) => s.claimId === "claim-d")).toBe(true);
		expect(result.referenceFlags).toEqual([]);
		expect(result.claimsChecked).toBe(3);
		expect(() => new Date(result.generatedAt).toISOString()).not.toThrow();
	});

	it("flags claims against a curated trusted reference when supplied", () => {
		const result = runReview({ claims: [CONFLICTING_PAIR[0]], references: [REFERENCE] });
		expect(result.referenceFlags.length).toBeGreaterThan(0);
		expect(result.referenceFlags[0].claimId).toBe("claim-a");
	});

	it("skips citation-integrity checking when knownCitationIds is omitted", () => {
		const result = runReview({ claims: [GROUNDED_CLAIM] });
		expect(result.citationIntegrity).toBeNull();
	});

	it("runs citation-integrity checking against the supplied known set", () => {
		const result = runReview({ claims: [GROUNDED_CLAIM], knownCitationIds: ["cite-4"] });
		expect(result.citationIntegrity).not.toBeNull();
		expect(result.citationIntegrity?.clean).toBe(false);
		expect(result.citationIntegrity?.dangling).toEqual([{ recordId: "claim-d", citationId: "cite-5" }]);
	});

	it("handles an empty claims array", () => {
		const result = runReview({ claims: [] });
		expect(result.inconsistencies).toEqual([]);
		expect(result.groundingSignals).toEqual([]);
		expect(result.referenceFlags).toEqual([]);
		expect(result.claimsChecked).toBe(0);
	});
});

describe("isClaim", () => {
	it("accepts a well-shaped claim", () => {
		expect(isClaim(GROUNDED_CLAIM)).toBe(true);
	});

	it("accepts a claim with an explicit confidence", () => {
		expect(isClaim({ ...GROUNDED_CLAIM, confidence: 0.5 })).toBe(true);
	});

	it("rejects a claim missing required fields", () => {
		expect(isClaim({ id: "x" })).toBe(false);
		expect(isClaim({ id: "", text: "t", citations: [] })).toBe(false);
		expect(isClaim({ id: "x", text: "t", citations: [1, 2] })).toBe(false);
		expect(isClaim({ id: "x", text: "t", citations: [], confidence: "high" })).toBe(false);
	});

	it("rejects non-objects", () => {
		expect(isClaim(null)).toBe(false);
		expect(isClaim("claim")).toBe(false);
		expect(isClaim(42)).toBe(false);
	});
});

describe("isTrustedReference", () => {
	it("accepts a well-shaped reference", () => {
		expect(isTrustedReference(REFERENCE)).toBe(true);
	});

	it("accepts a reference with an optional sourceUrl", () => {
		expect(isTrustedReference({ ...REFERENCE, sourceUrl: "https://example.test/ref" })).toBe(true);
	});

	it("rejects a reference missing required fields", () => {
		expect(isTrustedReference({ id: "ref-1", text: "t" })).toBe(false);
		expect(isTrustedReference({ id: "", text: "t", source: "s" })).toBe(false);
		expect(isTrustedReference({ id: "ref-1", text: "t", source: "s", sourceUrl: 5 })).toBe(false);
	});

	it("rejects non-objects", () => {
		expect(isTrustedReference(null)).toBe(false);
		expect(isTrustedReference([])).toBe(false);
	});
});

import { describe, expect, it, vi } from "vitest";
import { loadCuratedReferences, runReview } from "./review";
import * as inconsistencyFlagger from "./tools/inconsistencyFlagger";
import type { Claim, TrustedReference } from "./tools/inconsistencyFlagger";
import { createMemoryKv } from "./test/kvMock";
import { createRateLimiterNamespace } from "./test/doMock";
import { createReference } from "./references/store";

// Clearly-synthetic fixtures — not real content, not real people.
const CONFLICTING_PAIR: Claim[] = [
	{ id: "claim-a", text: "The synthetic widget was present at the sample facility.", citations: ["claim-b"] },
	{ id: "claim-b", text: "The synthetic widget was not present at the sample facility.", citations: ["claim-a"] },
];

const GROUNDED_CLAIM: Claim = {
	id: "claim-d",
	text: "Sample event gamma occurred at the fictional annex during the fictional quarter.",
	citations: ["ref-001", "dangling-cite"],
};

const SYNTHETIC_REFERENCE: TrustedReference = {
	id: "ref-001",
	text: "Synthetic Compound Zeta is metabolized by the synthetic pathway.",
	source: "SYNTHETIC-TEST Reference Manual, fictional edition",
};

describe("runReview", () => {
	it("computes findInconsistencies exactly once per call (#10)", () => {
		const spy = vi.spyOn(inconsistencyFlagger, "findInconsistencies");
		runReview([...CONFLICTING_PAIR, GROUNDED_CLAIM], [SYNTHETIC_REFERENCE]);
		expect(spy).toHaveBeenCalledTimes(1);
		spy.mockRestore();
	});

	it("returns all four review dimensions", () => {
		const result = runReview([...CONFLICTING_PAIR, GROUNDED_CLAIM], [SYNTHETIC_REFERENCE]);
		expect(result.selfConsistency.length).toBeGreaterThan(0);
		expect(result.groundingSignals.length).toBeGreaterThan(0);
		expect(result.citationIntegrity.recordsChecked).toBe(3);
	});

	it("flags a citation that points at nothing in this batch's claims/references", () => {
		const result = runReview([GROUNDED_CLAIM], []);
		expect(result.citationIntegrity.clean).toBe(false);
		expect(result.citationIntegrity.dangling).toContainEqual({ recordId: "claim-d", citationId: "dangling-cite" });
	});

	it("does not flag a citation that resolves to another claim or a reference in the same batch", () => {
		const result = runReview([...CONFLICTING_PAIR], []);
		expect(result.citationIntegrity.dangling).toEqual([]);
	});

	it("never uses assertive or overclaiming language in any combined output", () => {
		const result = runReview([...CONFLICTING_PAIR, GROUNDED_CLAIM], [SYNTHETIC_REFERENCE]);
		const forbidden = ["wrong", "false", "lying", "verified", "confirmed", "true", "valid"];
		for (const flag of result.selfConsistency) {
			expect(flag.confidence).toBeLessThan(1);
			for (const word of forbidden) expect(flag.note.toLowerCase().includes(word)).toBe(false);
		}
	});
});

describe("loadCuratedReferences (#71)", () => {
	it("returns every curated reference and truncated:false when well under the text budget", async () => {
		const kv = createMemoryKv();
		const rateLimiter = createRateLimiterNamespace(kv);
		await createReference(rateLimiter, kv, {
			id: "ref-a",
			text: "Fictional Compound Gamma has a demo interaction with fictional Compound Delta.",
			source: "SYNTHETIC-TEST Reference Manual, fictional edition",
			curator: "test-curator",
			scopeOfApplicability: "fictional demo persona only",
		});
		const { references, truncated } = await loadCuratedReferences(kv);
		expect(references).toHaveLength(1);
		expect(truncated).toBe(false);
	});

	it("stops loading and reports truncated:true once accumulated reference text would exceed the budget", async () => {
		const kv = createMemoryKv();
		const rateLimiter = createRateLimiterNamespace(kv);
		// Three fictional references whose combined text comfortably exceeds
		// REFERENCE_TEXT_BUDGET_CHARS (200 * 4000 = 800,000 chars) so the third one
		// tips the loader over the budget without needing 200+ separate entries.
		const hugeText = "Fictional synthetic filler text for a demo curated reference. ".repeat(6000); // ~384,000 chars
		for (const id of ["ref-a", "ref-b", "ref-c"]) {
			await createReference(rateLimiter, kv, {
				id,
				text: hugeText,
				source: "SYNTHETIC-TEST Reference Manual, fictional edition",
				curator: "test-curator",
				scopeOfApplicability: "fictional demo persona only",
			});
		}
		const { references, truncated } = await loadCuratedReferences(kv);
		expect(references.length).toBeLessThan(3);
		expect(truncated).toBe(true);
	});
});

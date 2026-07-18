import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryKv } from "../test/kvMock";
import { createReference } from "./store";
import { checkClaimsAgainstCuratedReferences, getCuratedTrustedReferences } from "./guard";
import type { Claim } from "../tools/inconsistencyFlagger";

// Fictional demo persona / fixtures only — see #19 hard constraint: no real references.
const FICTIONAL_REFERENCE_INPUT = {
	fact: "Synthetic Compound Zeta is metabolized by the synthetic pathway and interacts with synthetic pathway inhibitors.",
	source: "SYNTHETIC-TEST Reference Manual, fictional edition",
	sourceUrl: "https://example.invalid/synthetic-reference",
	curator: "demo-curator",
	scopeOfApplicability: "fictional demo persona only",
};

describe("getCuratedTrustedReferences", () => {
	it("returns exactly what a human curator added via the store — nothing more", async () => {
		const kv = createMemoryKv();
		const created = await createReference(kv, FICTIONAL_REFERENCE_INPUT);
		expect(created.ok).toBe(true);

		const references = await getCuratedTrustedReferences(kv);
		expect(references).toHaveLength(1);
		expect(references[0]).toEqual({
			id: created.ok ? created.reference.id : "",
			text: FICTIONAL_REFERENCE_INPUT.fact,
			source: FICTIONAL_REFERENCE_INPUT.source,
			sourceUrl: FICTIONAL_REFERENCE_INPUT.sourceUrl,
		});
	});

	it("returns an empty set when nothing has been curated — never a default/fallback source", async () => {
		const kv = createMemoryKv();
		expect(await getCuratedTrustedReferences(kv)).toEqual([]);
	});
});

describe("checkClaimsAgainstCuratedReferences: runtime guard against open-knowledge sourcing", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("never calls fetch — the only primitive this Worker has for reaching an LLM/external/open-knowledge source at runtime", async () => {
		const kv = createMemoryKv();
		await createReference(kv, FICTIONAL_REFERENCE_INPUT);

		const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("fetch must never be called by the reference guard"));

		const conflictingClaim: Claim = {
			id: "claim-f",
			text: "Synthetic Compound Zeta is not metabolized by the synthetic pathway and has a strong interaction with synthetic pathway inhibitors.",
			citations: ["cite-7"],
		};

		const flags = await checkClaimsAgainstCuratedReferences(kv, [conflictingClaim]);

		expect(fetchSpy).not.toHaveBeenCalled();
		expect(flags.length).toBeGreaterThan(0);
		expect(flags[0].appearsInconsistentWith).toBe((await getCuratedTrustedReferences(kv))[0].id);
	});

	it("flags are only ever traceable to references present in the curated store", async () => {
		const kv = createMemoryKv();
		const created = await createReference(kv, FICTIONAL_REFERENCE_INPUT);
		expect(created.ok).toBe(true);
		const curatedIds = created.ok ? [created.reference.id] : [];

		const conflictingClaim: Claim = {
			id: "claim-f",
			text: "Synthetic Compound Zeta is not metabolized by the synthetic pathway and has a strong interaction with synthetic pathway inhibitors.",
			citations: ["cite-7"],
		};

		const flags = await checkClaimsAgainstCuratedReferences(kv, [conflictingClaim]);
		for (const flag of flags) {
			expect(curatedIds).toContain(flag.appearsInconsistentWith);
		}
	});

	it("reflects a deletion immediately — no stale/cached reference set survives removal from the curated store", async () => {
		const kv = createMemoryKv();
		const created = await createReference(kv, FICTIONAL_REFERENCE_INPUT);
		expect(created.ok).toBe(true);

		const { deleteReference } = await import("./store");
		if (created.ok) await deleteReference(kv, created.reference.id);

		expect(await getCuratedTrustedReferences(kv)).toEqual([]);
	});
});

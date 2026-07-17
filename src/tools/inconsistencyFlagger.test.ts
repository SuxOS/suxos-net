import { describe, expect, it } from "vitest";
import {
	findGroundingSignals,
	findInconsistencies,
	flagAgainstReferences,
	type Claim,
	type TrustedReference,
} from "./inconsistencyFlagger";

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

const UNRELATED_CLAIM: Claim = {
	id: "claim-c",
	text: "A completely different synthetic gizmo was blue.",
	citations: ["cite-3"],
};

const GROUNDED_CLAIM: Claim = {
	id: "claim-d",
	text: "Sample event gamma occurred at the fictional annex during the fictional quarter.",
	citations: ["cite-4", "cite-5"],
};

const SINGLE_CITATION_CLAIM: Claim = {
	id: "claim-e",
	text: "Sample event delta occurred at the fictional annex during the fictional quarter.",
	citations: ["cite-6"],
};

const FORBIDDEN_WORDS = ["wrong", "false", "lying", "lied", "verified", "confirmed", "true", "valid"];

function assertNoOverclaiming(text: string) {
	const lower = text.toLowerCase();
	for (const word of FORBIDDEN_WORDS) {
		expect(lower.includes(word)).toBe(false);
	}
}

describe("findInconsistencies", () => {
	it("finds an intentionally-conflicting synthetic pair", () => {
		const flags = findInconsistencies(CONFLICTING_PAIR);
		expect(flags.length).toBeGreaterThan(0);
		const flag = flags[0];
		expect([flag.claimIdA, flag.claimIdB].sort()).toEqual(["claim-a", "claim-b"]);
		expect(flag.confidence).toBeLessThan(1);
		expect(flag.confidence).toBeGreaterThan(0);
		expect(["appearsInconsistentWith", "precedesConflictWith"]).toContain(flag.relation);
	});

	it("does not flag unrelated claims", () => {
		const flags = findInconsistencies([CONFLICTING_PAIR[0], UNRELATED_CLAIM]);
		expect(flags).toEqual([]);
	});

	it("does not treat 'now'/'afternoon'/'diagnosis' as substring matches for negation/temporal markers", () => {
		const claims: Claim[] = [
			{ id: "claim-h", text: "Patient is now stable per the diagnosis this afternoon.", citations: ["cite-9"] },
			{ id: "claim-i", text: "Patient is stable per the diagnosis this afternoon.", citations: ["cite-10"] },
		];
		expect(findInconsistencies(claims)).toEqual([]);
	});

	it("still detects negation via 'n't' contractions not individually listed, e.g. hasn't", () => {
		const claims: Claim[] = [
			{ id: "claim-j", text: "The synthetic widget has been present at the sample facility.", citations: ["cite-11"] },
			{ id: "claim-k", text: "The synthetic widget hasn't been present at the sample facility.", citations: ["cite-12"] },
		];
		const flags = findInconsistencies(claims);
		expect(flags.length).toBeGreaterThan(0);
	});

	it("never uses assertive or overclaiming language in its output", () => {
		const flags = findInconsistencies([...CONFLICTING_PAIR, UNRELATED_CLAIM, GROUNDED_CLAIM]);
		expect(flags.length).toBeGreaterThan(0);
		for (const flag of flags) {
			assertNoOverclaiming(flag.note);
			assertNoOverclaiming(flag.relation);
			expect(flag.confidence).toBeLessThan(1);
		}
	});
});

describe("findGroundingSignals", () => {
	it("gives a grounding signal to a claim with 2+ non-conflicting citations", () => {
		const signals = findGroundingSignals([GROUNDED_CLAIM, UNRELATED_CLAIM]);
		const signal = signals.find((s) => s.claimId === "claim-d");
		expect(signal).toBeDefined();
		expect(signal!.groundedBy).toEqual(["cite-4", "cite-5"]);
		expect(signal!.confidence).toBeLessThan(1);
		expect(signal!.confidence).toBeGreaterThan(0);
	});

	it("does not give a grounding signal to a claim with only 1 citation", () => {
		const signals = findGroundingSignals([SINGLE_CITATION_CLAIM, UNRELATED_CLAIM]);
		expect(signals.find((s) => s.claimId === "claim-e")).toBeUndefined();
	});

	it("does not give a grounding signal to a claim with an active inconsistency flag", () => {
		const conflictedButMultiCited: Claim = {
			...CONFLICTING_PAIR[0],
			citations: ["cite-1", "cite-1b"],
		};
		const signals = findGroundingSignals([conflictedButMultiCited, CONFLICTING_PAIR[1]]);
		expect(signals.find((s) => s.claimId === "claim-a")).toBeUndefined();
	});

	it("never uses assertive or overclaiming language in its output", () => {
		const signals = findGroundingSignals([GROUNDED_CLAIM, UNRELATED_CLAIM, ...CONFLICTING_PAIR]);
		expect(signals.length).toBeGreaterThan(0);
		for (const signal of signals) {
			assertNoOverclaiming(signal.note);
			expect(signal.confidence).toBeLessThan(1);
		}
	});

	it("given precomputedFlags, produces the same result as recomputing internally", () => {
		const claims = [GROUNDED_CLAIM, UNRELATED_CLAIM, ...CONFLICTING_PAIR];
		const flags = findInconsistencies(claims);
		expect(findGroundingSignals(claims, flags)).toEqual(findGroundingSignals(claims));
	});

	it("actually uses precomputedFlags rather than ignoring them", () => {
		// A conflict-free claims array would normally ground claim-a (2 distinct citations,
		// no conflict) — passing in an unrelated flag that names claim-a proves the passed-in
		// flags are what's consulted, not a freshly-recomputed set.
		const conflictFreeClaims: Claim[] = [{ ...CONFLICTING_PAIR[0], citations: ["cite-1", "cite-1b"] }];
		const fabricatedFlag = {
			claimIdA: "claim-a",
			claimIdB: "claim-z",
			relation: "appearsInconsistentWith" as const,
			confidence: 0.5,
			note: "synthetic test flag",
		};
		expect(findGroundingSignals(conflictFreeClaims).find((s) => s.claimId === "claim-a")).toBeDefined();
		expect(
			findGroundingSignals(conflictFreeClaims, [fabricatedFlag]).find((s) => s.claimId === "claim-a"),
		).toBeUndefined();
	});
});

// SYNTHETIC / TEST fixtures only — a fabricated placeholder reference, not a real
// pharmacological claim or a real drug. Standing in for a hand-curated bibliography.
const SYNTHETIC_REFERENCE: TrustedReference = {
	id: "ref-001",
	text: "Synthetic Compound Zeta is metabolized by the synthetic pathway and interacts with synthetic pathway inhibitors.",
	source: "SYNTHETIC-TEST Reference Manual, fictional edition",
	sourceUrl: "https://example.invalid/synthetic-reference",
};

const CONFLICTING_WITH_REFERENCE: Claim = {
	id: "claim-f",
	text: "Synthetic Compound Zeta is not metabolized by the synthetic pathway and has a strong interaction with synthetic pathway inhibitors.",
	citations: ["cite-7"],
};

const AGREEING_WITH_REFERENCE: Claim = {
	id: "claim-g",
	text: "Synthetic Compound Zeta is metabolized by the synthetic pathway, matching the standard reference description.",
	citations: ["cite-8"],
};

describe("flagAgainstReferences", () => {
	it("flags a synthetic claim that conflicts with a synthetic reference", () => {
		const flags = flagAgainstReferences([CONFLICTING_WITH_REFERENCE], [SYNTHETIC_REFERENCE]);
		expect(flags.length).toBeGreaterThan(0);
		const flag = flags[0];
		expect(flag.claimId).toBe("claim-f");
		expect(flag.appearsInconsistentWith).toBe("ref-001");
		expect(flag.confidence).toBeLessThan(1);
		expect(flag.confidence).toBeGreaterThan(0);
	});

	it("does not flag a synthetic claim that agrees with a synthetic reference", () => {
		const flags = flagAgainstReferences([AGREEING_WITH_REFERENCE], [SYNTHETIC_REFERENCE]);
		expect(flags).toEqual([]);
	});

	it("never uses assertive or overclaiming language in its output", () => {
		const flags = flagAgainstReferences(
			[CONFLICTING_WITH_REFERENCE, AGREEING_WITH_REFERENCE],
			[SYNTHETIC_REFERENCE],
		);
		expect(flags.length).toBeGreaterThan(0);
		for (const flag of flags) {
			assertNoOverclaiming(flag.note);
			expect(flag.confidence).toBeLessThan(1);
		}
	});
});

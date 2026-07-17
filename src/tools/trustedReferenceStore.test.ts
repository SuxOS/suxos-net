import { describe, expect, it } from "vitest";
import {
	assertCuratedProvenance,
	createTrustedReferenceStore,
	toTrustedReferences,
	type CuratedReferenceInput,
} from "./trustedReferenceStore";

const NOW = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-02T00:00:00.000Z";

const VALID_INPUT: CuratedReferenceInput = {
	fact: "Fictoprazine interacts with fictional Pathway-Q inhibitors.",
	source: "FICTIONAL-TEST Formulary Reference, invented edition",
	curator: "demo-curator@example.invalid",
	scopeOfApplicability: ["health"],
};

describe("createTrustedReferenceStore CRUD", () => {
	it("adds a reference and stamps id + dateAdded", () => {
		const store = createTrustedReferenceStore();
		const added = store.add(VALID_INPUT, NOW);
		expect(added.id).toBeTruthy();
		expect(added.dateAdded).toBe(NOW);
		expect(store.list()).toEqual([added]);
	});

	it("updates a reference and re-stamps dateAdded to the update time", () => {
		const store = createTrustedReferenceStore();
		const added = store.add(VALID_INPUT, NOW);
		const updated = store.update(added.id, { fact: "Revised fictional fact." }, LATER);
		expect(updated.fact).toBe("Revised fictional fact.");
		expect(updated.dateAdded).toBe(LATER);
		expect(updated.id).toBe(added.id);
	});

	it("removes a reference", () => {
		const store = createTrustedReferenceStore();
		const added = store.add(VALID_INPUT, NOW);
		store.remove(added.id);
		expect(store.get(added.id)).toBeUndefined();
		expect(store.list()).toEqual([]);
	});

	it("rejects updating an unknown reference id", () => {
		const store = createTrustedReferenceStore();
		expect(() => store.update("ref-does-not-exist", { fact: "x" }, NOW)).toThrow();
	});

	it("rejects removing an unknown reference id", () => {
		const store = createTrustedReferenceStore();
		expect(() => store.remove("ref-does-not-exist")).toThrow();
	});

	it("rejects an add with an empty fact, source, or curator", () => {
		const store = createTrustedReferenceStore();
		expect(() => store.add({ ...VALID_INPUT, fact: "  " }, NOW)).toThrow();
		expect(() => store.add({ ...VALID_INPUT, source: "" }, NOW)).toThrow();
		expect(() => store.add({ ...VALID_INPUT, curator: "" }, NOW)).toThrow();
	});

	it("rejects an add with no scope of applicability", () => {
		const store = createTrustedReferenceStore();
		expect(() => store.add({ ...VALID_INPUT, scopeOfApplicability: [] }, NOW)).toThrow();
	});
});

describe("assertCuratedProvenance (runtime guard against open-knowledge pulls)", () => {
	it("accepts a properly curated reference", () => {
		const store = createTrustedReferenceStore();
		const added = store.add(VALID_INPUT, NOW);
		expect(() => assertCuratedProvenance(added)).not.toThrow();
	});

	it("rejects a reference-shaped object with no curator field — e.g. a hypothetical runtime open-knowledge lookup result", () => {
		const openKnowledgeShaped = {
			id: "llm-result-1",
			text: "Some fact an LLM produced at request time.",
			source: "general knowledge",
		};
		expect(() => assertCuratedProvenance(openKnowledgeShaped)).toThrow(/curator/);
	});

	it("rejects a reference missing dateAdded even if curator is present", () => {
		const missingDate = { id: "x", fact: "y", source: "z", curator: "someone@example.invalid" };
		expect(() => assertCuratedProvenance(missingDate)).toThrow(/dateAdded/);
	});

	it("rejects a non-object candidate", () => {
		expect(() => assertCuratedProvenance("just a string")).toThrow();
		expect(() => assertCuratedProvenance(null)).toThrow();
	});
});

describe("toTrustedReferences", () => {
	it("adapts every curated store entry into the TrustedReference shape flagAgainstReferences expects", () => {
		const store = createTrustedReferenceStore();
		store.add(VALID_INPUT, NOW);
		const references = toTrustedReferences(store);
		expect(references).toEqual([
			{ id: expect.any(String), text: VALID_INPUT.fact, source: VALID_INPUT.source, sourceUrl: undefined },
		]);
	});

	it("returns an empty array for an empty store", () => {
		const store = createTrustedReferenceStore();
		expect(toTrustedReferences(store)).toEqual([]);
	});
});

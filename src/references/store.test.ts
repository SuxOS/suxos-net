import { describe, expect, it } from "vitest";
import { createRateLimiterNamespace } from "../test/doMock";
import { createMemoryKv } from "../test/kvMock";
import { createReference, deleteReference, getReference, listReferences, updateReference } from "./store";

// Fictional demo fixture only — not a real reference (#19 hard constraint).
const FICTIONAL_INPUT = {
	id: "ref-demo-1",
	text: "Fictional Compound Gamma has a demo interaction with fictional Compound Delta.",
	source: "SYNTHETIC-TEST Reference Manual, fictional edition",
	curator: "test-curator",
	scopeOfApplicability: "fictional demo persona only",
};

describe("createReference", () => {
	it("stamps dateAdded server-side from the provided clock", async () => {
		const kv = createMemoryKv();
		const rateLimiter = createRateLimiterNamespace(kv);
		const now = new Date("2026-07-18T00:00:00.000Z");
		const result = await createReference(rateLimiter, kv, FICTIONAL_INPUT, now);
		expect(result).toEqual({ ok: true, reference: { ...FICTIONAL_INPUT, dateAdded: now.toISOString() } });
	});

	it("rejects a duplicate id", async () => {
		const kv = createMemoryKv();
		const rateLimiter = createRateLimiterNamespace(kv);
		await createReference(rateLimiter, kv, FICTIONAL_INPUT);
		const dupe = await createReference(rateLimiter, kv, FICTIONAL_INPUT);
		expect(dupe).toEqual({ ok: false, error: "reference already exists" });
	});

	it("omits sourceUrl entirely when not provided", async () => {
		const kv = createMemoryKv();
		const rateLimiter = createRateLimiterNamespace(kv);
		const result = await createReference(rateLimiter, kv, FICTIONAL_INPUT);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.reference).not.toHaveProperty("sourceUrl");
	});
});

describe("getReference / listReferences", () => {
	it("returns null for a reference that was never created", async () => {
		const kv = createMemoryKv();
		expect(await getReference(kv, "no-such-id")).toBeNull();
	});

	it("lists every curated reference", async () => {
		const kv = createMemoryKv();
		const rateLimiter = createRateLimiterNamespace(kv);
		await createReference(rateLimiter, kv, FICTIONAL_INPUT);
		await createReference(rateLimiter, kv, { ...FICTIONAL_INPUT, id: "ref-demo-2" });
		const { references } = await listReferences(kv);
		expect(references.map((reference) => reference.id).sort()).toEqual(["ref-demo-1", "ref-demo-2"]);
	});
});

describe("updateReference", () => {
	it("edits a field and leaves dateAdded and other fields untouched", async () => {
		const kv = createMemoryKv();
		const rateLimiter = createRateLimiterNamespace(kv);
		const now = new Date("2026-07-18T00:00:00.000Z");
		await createReference(rateLimiter, kv, FICTIONAL_INPUT, now);

		const result = await updateReference(rateLimiter, kv, FICTIONAL_INPUT.id, { text: "Updated fictional text." });
		expect(result).toEqual({
			ok: true,
			reference: { ...FICTIONAL_INPUT, dateAdded: now.toISOString(), text: "Updated fictional text." },
		});
	});

	it("returns not-found for a reference that does not exist", async () => {
		const kv = createMemoryKv();
		const rateLimiter = createRateLimiterNamespace(kv);
		const result = await updateReference(rateLimiter, kv, "no-such-id", { text: "x" });
		expect(result).toEqual({ ok: false, error: "reference not found" });
	});
});

describe("deleteReference", () => {
	it("removes a reference so it is no longer gettable or listed", async () => {
		const kv = createMemoryKv();
		const rateLimiter = createRateLimiterNamespace(kv);
		await createReference(rateLimiter, kv, FICTIONAL_INPUT);
		const result = await deleteReference(kv, FICTIONAL_INPUT.id);
		expect(result).toEqual({ ok: true });
		expect(await getReference(kv, FICTIONAL_INPUT.id)).toBeNull();
		expect((await listReferences(kv)).references).toEqual([]);
	});

	it("returns not-found for a reference that does not exist", async () => {
		const kv = createMemoryKv();
		const result = await deleteReference(kv, "no-such-id");
		expect(result).toEqual({ ok: false, error: "reference not found" });
	});
});

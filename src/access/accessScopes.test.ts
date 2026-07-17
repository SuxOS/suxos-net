import { describe, expect, it } from "vitest";
import { createAccessScopeStore, isRecordScope, RECORD_SCOPE_VALUES } from "./accessScopes";

const NOW = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-02T00:00:00.000Z";

describe("isRecordScope", () => {
	it("accepts every declared scope value", () => {
		for (const scope of RECORD_SCOPE_VALUES) expect(isRecordScope(scope)).toBe(true);
	});

	it("rejects an unknown scope string", () => {
		expect(isRecordScope("everything")).toBe(false);
	});
});

describe("createAccessScopeStore", () => {
	it("default-denies an identity with no invite at all", () => {
		const store = createAccessScopeStore();
		expect(store.scopesForIdentity("nobody@example.invalid")).toEqual([]);
		expect(store.hasScope("nobody@example.invalid", "health")).toBe(false);
	});

	it("default-denies an identity with an unredeemed invite", () => {
		const store = createAccessScopeStore();
		store.issueInvite("pending@example.invalid", ["health"], NOW);
		expect(store.scopesForIdentity("pending@example.invalid")).toEqual([]);
		expect(store.hasScope("pending@example.invalid", "health")).toBe(false);
	});

	it("grants exactly the redeemed invite's scopes, nothing more", () => {
		const store = createAccessScopeStore();
		const invite = store.issueInvite("care-team@example.invalid", ["health"], NOW);
		store.redeemInvite(invite.id, LATER);
		expect(store.scopesForIdentity("care-team@example.invalid")).toEqual(["health"]);
		expect(store.hasScope("care-team@example.invalid", "health")).toBe(true);
		expect(store.hasScope("care-team@example.invalid", "legal")).toBe(false);
	});

	it("merges scopes across multiple redeemed invites for the same identity", () => {
		const store = createAccessScopeStore();
		const first = store.issueInvite("dual@example.invalid", ["health"], NOW);
		const second = store.issueInvite("dual@example.invalid", ["legal"], NOW);
		store.redeemInvite(first.id, LATER);
		store.redeemInvite(second.id, LATER);
		expect(new Set(store.scopesForIdentity("dual@example.invalid"))).toEqual(new Set(["health", "legal"]));
	});

	it("rejects issuing an invite with no scopes", () => {
		const store = createAccessScopeStore();
		expect(() => store.issueInvite("nobody@example.invalid", [], NOW)).toThrow();
	});

	it("rejects redeeming an unknown invite id", () => {
		const store = createAccessScopeStore();
		expect(() => store.redeemInvite("invite-does-not-exist", NOW)).toThrow();
	});

	it("rejects redeeming the same invite twice", () => {
		const store = createAccessScopeStore();
		const invite = store.issueInvite("care-team@example.invalid", ["health"], NOW);
		store.redeemInvite(invite.id, LATER);
		expect(() => store.redeemInvite(invite.id, LATER)).toThrow();
	});

	it("does not leak one recipient's scopes onto a different identity", () => {
		const store = createAccessScopeStore();
		const invite = store.issueInvite("attorney@example.invalid", ["legal"], NOW);
		store.redeemInvite(invite.id, LATER);
		expect(store.scopesForIdentity("family@example.invalid")).toEqual([]);
	});

	it("lists every issued invite regardless of redemption state", () => {
		const store = createAccessScopeStore();
		store.issueInvite("a@example.invalid", ["health"], NOW);
		store.issueInvite("b@example.invalid", ["legal"], NOW);
		expect(store.listInvites().length).toBe(2);
	});
});

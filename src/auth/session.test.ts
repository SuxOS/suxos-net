import { describe, expect, it } from "vitest";
import { createSessionToken, verifySessionToken } from "./session";

const SECRET = "test-session-secret-do-not-use-in-prod";

describe("createSessionToken / verifySessionToken", () => {
	it("round-trips a plain username", async () => {
		const token = await createSessionToken("alice", SECRET);
		const payload = await verifySessionToken(token, SECRET);
		expect(payload?.username).toBe("alice");
		expect(payload?.epoch).toBe(0);
	});

	// suxos-net#80: a flat `token.split(".")` expecting exactly 3 parts rejected any
	// username containing a dot (e.g. "jane.doe", "first.last@team") on every request
	// AFTER login, since handleLogin never calls verifySessionToken itself.
	it("round-trips a dotted username", async () => {
		const token = await createSessionToken("jane.doe", SECRET);
		const payload = await verifySessionToken(token, SECRET);
		expect(payload?.username).toBe("jane.doe");
	});

	it("round-trips a username with several dots", async () => {
		const token = await createSessionToken("first.middle.last", SECRET);
		const payload = await verifySessionToken(token, SECRET);
		expect(payload?.username).toBe("first.middle.last");
	});

	it("embeds and returns a non-zero epoch (#81)", async () => {
		const token = await createSessionToken("alice", SECRET, 3);
		const payload = await verifySessionToken(token, SECRET);
		expect(payload?.epoch).toBe(3);
	});

	it("rejects a token signed with a different secret", async () => {
		const token = await createSessionToken("alice", SECRET);
		const payload = await verifySessionToken(token, "a-different-secret");
		expect(payload).toBeNull();
	});

	it("rejects an expired token", async () => {
		const longAgo = Date.now() - 1000 * 60 * 60 * 48;
		const token = await createSessionToken("alice", SECRET, 0, longAgo);
		const payload = await verifySessionToken(token, SECRET);
		expect(payload).toBeNull();
	});

	it("rejects a malformed token with too few segments", async () => {
		expect(await verifySessionToken("not-a-real-token", SECRET)).toBeNull();
		expect(await verifySessionToken("only.two", SECRET)).toBeNull();
	});

	it("rejects a token whose username segment is empty once epoch/expiry/signature are stripped", async () => {
		expect(await verifySessionToken(".0.9999999999999.deadbeef", SECRET)).toBeNull();
	});

	it("fails closed when the secret is empty, for signing and verifying alike", async () => {
		await expect(createSessionToken("alice", "")).rejects.toThrow(/SESSION_SECRET/);
		const token = await createSessionToken("alice", SECRET);
		expect(await verifySessionToken(token, "")).toBeNull();
	});
});

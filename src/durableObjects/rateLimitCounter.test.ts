import { describe, expect, it } from "vitest";
import { nextRateLimitState, RateLimitCounter } from "./rateLimitCounter";
import { createInMemoryDurableObjectNamespace } from "../testUtils/durableObject";

describe("nextRateLimitState (pure)", () => {
	it("allows and increments from a fresh (undefined) state", () => {
		const result = nextRateLimitState(undefined, 100, 5);
		expect(result).toEqual({ window: 100, count: 1, allowed: true });
	});

	it("keeps incrementing within the same window up to max", () => {
		let state = nextRateLimitState(undefined, 100, 3);
		state = nextRateLimitState(state, 100, 3);
		state = nextRateLimitState(state, 100, 3);
		expect(state).toEqual({ window: 100, count: 3, allowed: true });
	});

	it("refuses once count reaches max in the same window", () => {
		const atMax = { window: 100, count: 3 };
		expect(nextRateLimitState(atMax, 100, 3)).toEqual({ window: 100, count: 3, allowed: false });
	});

	it("resets the count when the window bucket changes", () => {
		const staleWindow = { window: 100, count: 3 };
		expect(nextRateLimitState(staleWindow, 101, 3)).toEqual({ window: 101, count: 1, allowed: true });
	});
});

describe("RateLimitCounter (DO, via in-memory fake)", () => {
	function namespace() {
		return createInMemoryDurableObjectNamespace((state) => new RateLimitCounter(state));
	}

	async function check(stub: DurableObjectStub, windowBucket: number, max: number): Promise<boolean> {
		const res = await stub.fetch("https://rate-limit-counter/check", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ windowBucket, max }),
		});
		return ((await res.json()) as { allowed: boolean }).allowed;
	}

	it("persists count across calls to the same identity", async () => {
		const ns = namespace();
		const stub = ns.get(ns.idFromName("client-a"));
		expect(await check(stub, 1, 2)).toBe(true);
		expect(await check(stub, 1, 2)).toBe(true);
		expect(await check(stub, 1, 2)).toBe(false);
	});

	it("keeps separate identities independent", async () => {
		const ns = namespace();
		const a = ns.get(ns.idFromName("client-a"));
		const b = ns.get(ns.idFromName("client-b"));
		for (let i = 0; i < 2; i++) await check(a, 1, 2);
		expect(await check(a, 1, 2)).toBe(false);
		expect(await check(b, 1, 2)).toBe(true);
	});

	it("never allows more than max through under concurrent calls to the same identity", async () => {
		const ns = namespace();
		const stub = ns.get(ns.idFromName("client-concurrent"));
		const results = await Promise.all(Array.from({ length: 50 }, () => check(stub, 1, 10)));
		expect(results.filter(Boolean).length).toBe(10);
	});
});

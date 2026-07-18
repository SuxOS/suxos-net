import { afterEach, describe, expect, it, vi } from "vitest";
import { createRateLimiterNamespace } from "../test/doMock";
import { isIpRequestAllowed } from "./rateLimiter";
import { AUTH_LOCKOUT_CONSTANTS, checkLockout, clearFailedAttempts, recordFailedAttempt } from "./store";

const IP_LIMIT = 60;
const IP_WINDOW_MS = 60_000;
const { MAX_FAILED_ATTEMPTS, LOCKOUT_WINDOW_MS } = AUTH_LOCKOUT_CONSTANTS;

afterEach(() => {
	vi.restoreAllMocks();
});

describe("RateLimiterDO — per-IP fixed-window limiter (atomic)", () => {
	it("allows exactly the budget then blocks (sequential)", async () => {
		const ns = createRateLimiterNamespace();
		const results: boolean[] = [];
		for (let i = 0; i < IP_LIMIT + 1; i++) {
			results.push(await isIpRequestAllowed(ns, "1.2.3.4", IP_LIMIT, IP_WINDOW_MS));
		}
		expect(results.filter((allowed) => allowed).length).toBe(IP_LIMIT);
		expect(results[IP_LIMIT]).toBe(false); // the (limit+1)-th request is blocked
	});

	it("tracks each IP independently", async () => {
		const ns = createRateLimiterNamespace();
		for (let i = 0; i < IP_LIMIT + 5; i++) {
			await isIpRequestAllowed(ns, "5.6.7.8", IP_LIMIT, IP_WINDOW_MS);
		}
		// A different IP is unaffected by the first IP exhausting its budget.
		expect(await isIpRequestAllowed(ns, "9.9.9.9", IP_LIMIT, IP_WINDOW_MS)).toBe(true);
	});

	it("holds the budget under a concurrent burst — the TOCTOU regression (#35)", async () => {
		// This is the case KV could not defend: fire far more than the budget all at
		// once. With the old get-then-put on KV, concurrent requests read the same
		// pre-increment count and pass together. The DO serialises increment-and-check,
		// so no more than the budget is ever admitted, no matter the concurrency.
		const ns = createRateLimiterNamespace();
		const burst = 250;
		const outcomes = await Promise.all(
			Array.from({ length: burst }, () => isIpRequestAllowed(ns, "10.0.0.1", IP_LIMIT, IP_WINDOW_MS)),
		);
		expect(outcomes.filter((allowed) => allowed).length).toBe(IP_LIMIT);
		expect(outcomes.filter((allowed) => !allowed).length).toBe(burst - IP_LIMIT);
	});
});

describe("RateLimiterDO — per-username lockout (atomic)", () => {
	it("does not lock before the threshold, locks on reaching it", async () => {
		const ns = createRateLimiterNamespace();
		for (let i = 0; i < MAX_FAILED_ATTEMPTS - 1; i++) {
			await recordFailedAttempt(ns, "erin");
		}
		expect((await checkLockout(ns, "erin")).locked).toBe(false);

		await recordFailedAttempt(ns, "erin"); // the MAX_FAILED_ATTEMPTS-th failure
		const status = await checkLockout(ns, "erin");
		expect(status.locked).toBe(true);
		expect(status.retryAfterMs).toBeGreaterThan(0);
		expect(status.retryAfterMs).toBeLessThanOrEqual(LOCKOUT_WINDOW_MS);
	});

	it("holds the lockout threshold under a concurrent burst of failures (#35)", async () => {
		// The lockout counter was the second TOCTOU HIGH: concurrent failed logins each
		// read the same count and never trip the 5-attempt threshold. Serialised through
		// the DO, a burst of failures locks the account just as a sequence would.
		const ns = createRateLimiterNamespace();
		await Promise.all(Array.from({ length: 20 }, () => recordFailedAttempt(ns, "mallory")));
		expect((await checkLockout(ns, "mallory")).locked).toBe(true);
	});

	it("keys lockouts per username", async () => {
		const ns = createRateLimiterNamespace();
		for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) await recordFailedAttempt(ns, "erin");
		expect((await checkLockout(ns, "erin")).locked).toBe(true);
		expect((await checkLockout(ns, "someone-else")).locked).toBe(false);
	});

	it("normalises the username (trim + lowercase) so the key is stable", async () => {
		const ns = createRateLimiterNamespace();
		for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) await recordFailedAttempt(ns, "  Erin  ");
		expect((await checkLockout(ns, "erin")).locked).toBe(true);
	});

	it("clearFailedAttempts resets the counter", async () => {
		const ns = createRateLimiterNamespace();
		for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) await recordFailedAttempt(ns, "erin");
		expect((await checkLockout(ns, "erin")).locked).toBe(true);

		await clearFailedAttempts(ns, "erin");
		expect((await checkLockout(ns, "erin")).locked).toBe(false);
	});

	it("resets the accumulation window once it fully elapses", async () => {
		const ns = createRateLimiterNamespace();
		const base = 1_700_000_000_000;
		const clock = vi.spyOn(Date, "now").mockReturnValue(base);

		for (let i = 0; i < MAX_FAILED_ATTEMPTS - 1; i++) await recordFailedAttempt(ns, "erin");
		expect((await checkLockout(ns, "erin")).locked).toBe(false);

		// Jump past the window: the next failure starts a fresh count of 1, not the 5th.
		clock.mockReturnValue(base + LOCKOUT_WINDOW_MS + 1);
		await recordFailedAttempt(ns, "erin");
		expect((await checkLockout(ns, "erin")).locked).toBe(false);
	});

	it("a lock expires once its window passes", async () => {
		const ns = createRateLimiterNamespace();
		const base = 1_700_000_000_000;
		const clock = vi.spyOn(Date, "now").mockReturnValue(base);

		for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) await recordFailedAttempt(ns, "erin");
		expect((await checkLockout(ns, "erin")).locked).toBe(true);

		clock.mockReturnValue(base + LOCKOUT_WINDOW_MS + 1);
		expect((await checkLockout(ns, "erin")).locked).toBe(false);
	});
});

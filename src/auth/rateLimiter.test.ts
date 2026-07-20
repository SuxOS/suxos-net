import { afterEach, describe, expect, it, vi } from "vitest";
import { createRateLimiterNamespace } from "../test/doMock";
import { isIpRequestAllowed } from "./rateLimiter";
import { admitLoginAttempt, AUTH_LOCKOUT_CONSTANTS, clearFailedAttempts } from "./store";

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

// admitLoginAttempt (RateLimiterDO's "lockoutAdmit" op) is the ONLY lockout gate wired
// into /login (src/auth/routes.ts) — there is no separate check-then-record step to
// test in isolation, so these exercise the atomic admit-and-count primitive directly.
describe("RateLimiterDO — per-username lockout (atomic)", () => {
	it("does not lock before the threshold, locks on reaching it", async () => {
		const ns = createRateLimiterNamespace();
		for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) {
			expect((await admitLoginAttempt(ns, "erin")).admitted).toBe(true);
		}

		const result = await admitLoginAttempt(ns, "erin"); // the (MAX_FAILED_ATTEMPTS + 1)-th attempt
		expect(result.admitted).toBe(false);
		expect(result.retryAfterMs).toBeGreaterThan(0);
		expect(result.retryAfterMs).toBeLessThanOrEqual(LOCKOUT_WINDOW_MS);
	});

	it("holds the lockout threshold under a concurrent burst of failures (#35)", async () => {
		// The lockout counter was the second TOCTOU HIGH: concurrent failed logins each
		// read the same count and never trip the 5-attempt threshold. Serialised through
		// the DO, a burst of attempts admits exactly the budget, no matter the concurrency.
		const ns = createRateLimiterNamespace();
		const burst = 20;
		const outcomes = await Promise.all(Array.from({ length: burst }, () => admitLoginAttempt(ns, "mallory")));
		expect(outcomes.filter((r) => r.admitted).length).toBe(MAX_FAILED_ATTEMPTS);
		expect(outcomes.filter((r) => !r.admitted).length).toBe(burst - MAX_FAILED_ATTEMPTS);
	});

	it("keys lockouts per username", async () => {
		const ns = createRateLimiterNamespace();
		for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) await admitLoginAttempt(ns, "erin");
		expect((await admitLoginAttempt(ns, "erin")).admitted).toBe(false);
		expect((await admitLoginAttempt(ns, "someone-else")).admitted).toBe(true);
	});

	it("normalises the username (trim + lowercase) so the key is stable", async () => {
		const ns = createRateLimiterNamespace();
		for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) await admitLoginAttempt(ns, "  Erin  ");
		expect((await admitLoginAttempt(ns, "erin")).admitted).toBe(false);
	});

	it("clearFailedAttempts resets the counter", async () => {
		const ns = createRateLimiterNamespace();
		for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) await admitLoginAttempt(ns, "erin");
		expect((await admitLoginAttempt(ns, "erin")).admitted).toBe(false);

		await clearFailedAttempts(ns, "erin");
		expect((await admitLoginAttempt(ns, "erin")).admitted).toBe(true);
	});

	it("resets the accumulation window once it fully elapses", async () => {
		const ns = createRateLimiterNamespace();
		const base = 1_700_000_000_000;
		const clock = vi.spyOn(Date, "now").mockReturnValue(base);

		for (let i = 0; i < MAX_FAILED_ATTEMPTS - 1; i++) {
			expect((await admitLoginAttempt(ns, "erin")).admitted).toBe(true);
		}

		// Jump past the window: the next attempt starts a fresh count of 1, not the
		// MAX_FAILED_ATTEMPTS-th — if the window hadn't reset, this would trip the lock.
		clock.mockReturnValue(base + LOCKOUT_WINDOW_MS + 1);
		expect((await admitLoginAttempt(ns, "erin")).admitted).toBe(true);
	});

	it("a lock expires once its window passes", async () => {
		const ns = createRateLimiterNamespace();
		const base = 1_700_000_000_000;
		const clock = vi.spyOn(Date, "now").mockReturnValue(base);

		for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) await admitLoginAttempt(ns, "erin");
		expect((await admitLoginAttempt(ns, "erin")).admitted).toBe(false);

		clock.mockReturnValue(base + LOCKOUT_WINDOW_MS + 1);
		expect((await admitLoginAttempt(ns, "erin")).admitted).toBe(true);
	});
});

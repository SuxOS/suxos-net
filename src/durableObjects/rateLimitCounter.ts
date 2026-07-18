// Atomic increment-and-check counter (issue #55 — the current /api/* rate limiter's
// own comment in ../index.ts admits its KV get-then-put "can undercount" under real
// concurrency). A Durable Object instance serializes every call it receives, so the
// get-then-put below is actually atomic here, unlike the KV version it replaces.
//
// Deliberately implements the plain `fetch`-based DurableObject interface (no
// `import { DurableObject } from "cloudflare:workers"` RPC base class) so this file
// stays importable under plain-Node vitest, same as every other module in this repo —
// see src/testUtils/durableObject.ts for the in-memory fake used in tests.

export interface CounterState {
	window: number;
	count: number;
}

export interface RateLimitCheckResult extends CounterState {
	allowed: boolean;
}

/**
 * Pure fixed-window increment-and-check: `stored` is whatever was persisted from the
 * previous call (or undefined on first use). A window change resets the count. No
 * I/O — the DurableObject class below just persists whatever this returns.
 */
export function nextRateLimitState(
	stored: CounterState | undefined,
	windowBucket: number,
	max: number,
): RateLimitCheckResult {
	const current = stored && stored.window === windowBucket ? stored.count : 0;
	if (current >= max) return { window: windowBucket, count: current, allowed: false };
	return { window: windowBucket, count: current + 1, allowed: true };
}

const STATE_KEY = "state";

export class RateLimitCounter implements DurableObject {
	constructor(private readonly ctx: DurableObjectState) {}

	async fetch(request: Request): Promise<Response> {
		const { windowBucket, max } = (await request.json()) as { windowBucket: number; max: number };
		const stored = await this.ctx.storage.get<CounterState>(STATE_KEY);
		const result = nextRateLimitState(stored, windowBucket, max);
		if (result.allowed) {
			await this.ctx.storage.put(STATE_KEY, { window: result.window, count: result.count });
		}
		return Response.json({ allowed: result.allowed });
	}
}

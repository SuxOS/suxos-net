/**
 * Atomic rate-limit / lockout counters backed by a Durable Object (suxos-net#35).
 *
 * WHY a Durable Object and not KV: Cloudflare KV has NO atomic increment. The
 * previous KV-backed counters did get-then-put, so a burst of concurrent requests
 * could all read the same pre-increment value, each decide it was under the budget,
 * and pass together — a TOCTOU race that let a client blow straight past both the
 * per-IP request limiter and the per-username login lockout (the two security-review
 * HIGHs on #35). Client-side concurrency alone defeated both counters.
 *
 * A Durable Object serialises every request for a given id through a single instance
 * (the input gate holds new events while an in-flight storage read-modify-write
 * settles), so increment-and-check is atomic and the limit becomes a hard guarantee
 * rather than a best-effort deterrent. One DO instance per logical key
 * (idFromName(key)) — the race is per-key, so per-key instances both close it and
 * avoid a single global bottleneck.
 *
 * WHY a classic `fetch`-handler DO and not an RPC (`extends DurableObject`) one:
 * this repo's test suite runs under the plain `node` vitest environment (there is no
 * @cloudflare/vitest-pool-workers here), and an RPC DO must
 * `import { DurableObject } from "cloudflare:workers"` — a virtual module that only
 * resolves inside workerd. Importing it would break every existing node test at load
 * time. A fetch-handler DO needs no such import and is serialised by the exact same
 * input gate, so the atomicity guarantee that closes the TOCTOU is identical. The
 * typed client helpers below keep the Worker's call sites ergonomic and type-safe.
 */

// --- Wire protocol (Worker <-> DO). One POST per operation; body is one of these. ---

interface FixedWindowRequest {
	op: "fixedWindow";
	limit: number;
	windowMs: number;
}
interface LockoutStatusRequest {
	op: "lockoutStatus";
}
interface LockoutRecordRequest {
	op: "lockoutRecord";
	maxAttempts: number;
	windowMs: number;
}
interface LockoutClearRequest {
	op: "lockoutClear";
}
type RateLimiterRequest = FixedWindowRequest | LockoutStatusRequest | LockoutRecordRequest | LockoutClearRequest;

export interface LockoutStatus {
	locked: boolean;
	retryAfterMs?: number;
}

// --- Persisted per-instance state (one instance == one logical key). ---

interface FixedWindowState {
	count: number;
	windowStart: number;
}
interface LockoutState {
	failedAttempts: number;
	windowStartedAt: number;
	lockedUntil?: number;
}

const FIXED_WINDOW_SLOT = "fixedWindow";
const LOCKOUT_SLOT = "lockout";

/**
 * The Durable Object. Every request for one id runs single-threaded through one
 * instance, so each handler below performs its storage read-modify-write with no
 * interleaving from a concurrent request for the same id — that serialisation is the
 * whole point (it is what KV could not provide). Storage uses the KV-style async API
 * (`storage.get/put/delete`), which is backed by SQLite under `new_sqlite_classes`.
 */
export class RateLimiterDO {
	private readonly storage: DurableObjectStorage;

	constructor(ctx: DurableObjectState) {
		this.storage = ctx.storage;
	}

	async fetch(request: Request): Promise<Response> {
		const body = (await request.json()) as RateLimiterRequest;
		switch (body.op) {
			case "fixedWindow":
				return Response.json(await this.fixedWindow(body.limit, body.windowMs));
			case "lockoutStatus":
				return Response.json(await this.lockoutStatus());
			case "lockoutRecord":
				await this.lockoutRecord(body.maxAttempts, body.windowMs);
				return Response.json({ ok: true });
			case "lockoutClear":
				await this.storage.delete(LOCKOUT_SLOT);
				return Response.json({ ok: true });
			default:
				return Response.json({ error: "unknown op" }, { status: 400 });
		}
	}

	/**
	 * Fixed-window request counter. Returns whether this request is under the budget
	 * and, when it is, atomically records it. `count >= limit` blocks without a
	 * further increment, so exactly `limit` requests pass per window — matching the
	 * previous KV limiter's budget, now without the get-then-put race.
	 */
	private async fixedWindow(limit: number, windowMs: number): Promise<{ allowed: boolean }> {
		const now = Date.now();
		const existing = await this.storage.get<FixedWindowState>(FIXED_WINDOW_SLOT);
		const state: FixedWindowState =
			existing && now - existing.windowStart < windowMs ? existing : { count: 0, windowStart: now };
		if (state.count >= limit) return { allowed: false };
		await this.storage.put(FIXED_WINDOW_SLOT, { count: state.count + 1, windowStart: state.windowStart });
		return { allowed: true };
	}

	/** Read-only lockout check — mirrors the old checkLockout semantics exactly. */
	private async lockoutStatus(now: number = Date.now()): Promise<LockoutStatus> {
		const state = await this.storage.get<LockoutState>(LOCKOUT_SLOT);
		if (!state) return { locked: false };
		if (state.lockedUntil && now < state.lockedUntil) {
			return { locked: true, retryAfterMs: state.lockedUntil - now };
		}
		return { locked: false };
	}

	/**
	 * Records one failed login attempt — mirrors the old recordFailedAttempt exactly:
	 * a sliding accumulation window (reset once it fully elapses) and, on reaching
	 * `maxAttempts`, a lock that runs `windowMs` from the tripping attempt.
	 */
	private async lockoutRecord(maxAttempts: number, windowMs: number, now: number = Date.now()): Promise<void> {
		const existing = await this.storage.get<LockoutState>(LOCKOUT_SLOT);
		let state: LockoutState = existing ?? { failedAttempts: 0, windowStartedAt: now };
		if (now - state.windowStartedAt > windowMs) {
			state = { failedAttempts: 0, windowStartedAt: now };
		}
		state.failedAttempts += 1;
		if (state.failedAttempts >= maxAttempts) {
			state.lockedUntil = now + windowMs;
		}
		await this.storage.put(LOCKOUT_SLOT, state);
	}
}

// --- Typed client helpers used by the Worker. Each targets one DO instance keyed by
// the logical key, so per-key counters never collide and each is serialised on its own. ---

/** Normalises a username to the lockout key exactly as the old KV lockoutKey did. */
function loginKey(username: string): string {
	return `login:${username.trim().toLowerCase()}`;
}

async function callDO<T>(namespace: DurableObjectNamespace, key: string, body: RateLimiterRequest): Promise<T> {
	const stub = namespace.get(namespace.idFromName(key));
	const res = await stub.fetch("https://rate-limiter.internal/", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return (await res.json()) as T;
}

/** Per-IP fixed-window limiter. Returns true when the request is under the budget. */
export async function isIpRequestAllowed(
	namespace: DurableObjectNamespace,
	ip: string,
	limit: number,
	windowMs: number,
): Promise<boolean> {
	const { allowed } = await callDO<{ allowed: boolean }>(namespace, `ip:${ip}`, { op: "fixedWindow", limit, windowMs });
	return allowed;
}

export async function getLockoutStatus(namespace: DurableObjectNamespace, username: string): Promise<LockoutStatus> {
	return callDO<LockoutStatus>(namespace, loginKey(username), { op: "lockoutStatus" });
}

export async function recordLockoutFailure(
	namespace: DurableObjectNamespace,
	username: string,
	maxAttempts: number,
	windowMs: number,
): Promise<void> {
	await callDO(namespace, loginKey(username), { op: "lockoutRecord", maxAttempts, windowMs });
}

export async function clearLockout(namespace: DurableObjectNamespace, username: string): Promise<void> {
	await callDO(namespace, loginKey(username), { op: "lockoutClear" });
}

/**
 * Atomic rate-limit / lockout counters backed by a Durable Object (suxos-net#35).
 * Also backs atomic KV read-modify-write for account records (suxos-net#84) — see
 * the "kvMerge" op below.
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
 *
 * "kvMerge" reuses this SAME DO/binding (rather than provisioning a second Durable
 * Object class + migration) to close the account-record TOCTOU flagged in #84:
 * createAccount/resetPassword/revokeSessions (src/auth/store.ts) used to do a plain
 * kv.get-then-put on the same account key. Routing that read-modify-write through
 * one DO fetch call, keyed by the account's own KV key, means the whole
 * get-mutate-put runs inside a single input-gated turn — concurrent admin actions on
 * the same account are serialised exactly like the login-lockout counter above,
 * instead of racing each other in KV directly. The DO reaches KV via `env.NAV_CACHE`,
 * the same binding the Worker already has (no wrangler.jsonc change needed — DO
 * classes exported from the Worker's own script receive the Worker's env).
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
interface LockoutAdmitRequest {
	op: "lockoutAdmit";
	maxAttempts: number;
	windowMs: number;
}
interface KvMergeRequest {
	op: "kvMerge";
	kvKey: string;
	patch: Record<string, unknown>;
	requireExisting: boolean;
	bumpField?: string;
}
type RateLimiterRequest =
	| FixedWindowRequest
	| LockoutStatusRequest
	| LockoutRecordRequest
	| LockoutClearRequest
	| LockoutAdmitRequest
	| KvMergeRequest;

export interface LockoutStatus {
	locked: boolean;
	retryAfterMs?: number;
}

export interface LockoutAdmitResult {
	admitted: boolean;
	retryAfterMs?: number;
}

export interface KvMergeResult {
	ok: boolean;
	error?: string;
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
	// Optional: only "kvMerge" callers need this. Absent in any environment that
	// doesn't pass a NAV_CACHE binding (e.g. an older/unrelated Worker embedding this
	// class) — those simply can't use "kvMerge", every other op is unaffected.
	private readonly kv?: KVNamespace;

	constructor(ctx: DurableObjectState, env?: { NAV_CACHE?: KVNamespace }) {
		this.storage = ctx.storage;
		this.kv = env?.NAV_CACHE;
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
			case "lockoutAdmit":
				return Response.json(await this.lockoutAdmit(body.maxAttempts, body.windowMs));
			case "kvMerge":
				return Response.json(await this.kvMerge(body.kvKey, body.patch, body.requireExisting, body.bumpField));
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

	/**
	 * Atomic admission control for a login attempt — the single DO round-trip that
	 * REPLACES the old check-then-(PBKDF2)-then-record split (suxos-net#35 residual
	 * HIGH). The prior flow read the lock, ran a slow PBKDF2, then recorded a failure
	 * as three separate steps: a concurrent burst of guesses all passed the read
	 * (nothing recorded yet) and each got a full verify before any of them counted, so
	 * an attacker got N attempts instead of `maxAttempts`. Counting the attempt HERE, at
	 * entry, in the DO's single input-gated op means each concurrent request gets a
	 * distinct sequential count: the first `maxAttempts` are admitted (and go on to the
	 * verify), every one past that is rejected and locked BEFORE any PBKDF2 runs. A
	 * successful login clears the counter (lockoutClear), so honest users reset.
	 */
	private async lockoutAdmit(maxAttempts: number, windowMs: number, now: number = Date.now()): Promise<LockoutAdmitResult> {
		const existing = await this.storage.get<LockoutState>(LOCKOUT_SLOT);
		// Already locked → reject WITHOUT counting, so more guesses can't extend the lock.
		if (existing?.lockedUntil && now < existing.lockedUntil) {
			return { admitted: false, retryAfterMs: existing.lockedUntil - now };
		}
		// Keep the running window, or start a fresh one once it has fully elapsed.
		const state: LockoutState =
			existing && now - existing.windowStartedAt <= windowMs ? existing : { failedAttempts: 0, windowStartedAt: now };
		state.failedAttempts += 1;
		if (state.failedAttempts > maxAttempts) {
			state.lockedUntil = now + windowMs;
			await this.storage.put(LOCKOUT_SLOT, state);
			return { admitted: false, retryAfterMs: windowMs };
		}
		await this.storage.put(LOCKOUT_SLOT, state);
		return { admitted: true };
	}

	/**
	 * Atomic KV read-modify-write (#84): reads `kvKey`, applies `patch` (shallow-merged
	 * over the existing JSON object, or over `{}` if the key doesn't exist yet),
	 * optionally increments `bumpField` by one, and writes the result back — all inside
	 * this single DO fetch call, so a concurrent call for the same `kvKey` (same DO id)
	 * queues behind it instead of racing it in KV directly. `requireExisting` gates
	 * update-only (reset/revoke: fail if absent) vs create-only (fail if already
	 * present) callers with one shared code path.
	 */
	private async kvMerge(
		kvKey: string,
		patch: Record<string, unknown>,
		requireExisting: boolean,
		bumpField?: string,
	): Promise<KvMergeResult> {
		if (!this.kv) return { ok: false, error: "kvMerge unavailable: no NAV_CACHE binding" };
		const raw = await this.kv.get(kvKey);
		if (requireExisting && raw === null) return { ok: false, error: "not found" };
		if (!requireExisting && raw !== null) return { ok: false, error: "already exists" };

		const current = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
		const merged: Record<string, unknown> = { ...current, ...patch };
		if (bumpField) {
			const prev = typeof current[bumpField] === "number" ? (current[bumpField] as number) : 0;
			merged[bumpField] = prev + 1;
		}
		await this.kv.put(kvKey, JSON.stringify(merged));
		return { ok: true };
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

/**
 * Atomically count this login attempt and report whether it may proceed. One DO
 * round-trip — the whole point is that the count and the decision cannot be split by a
 * concurrent request (see RateLimiterDO.lockoutAdmit).
 */
export async function admitLoginAttempt(
	namespace: DurableObjectNamespace,
	username: string,
	maxAttempts: number,
	windowMs: number,
): Promise<LockoutAdmitResult> {
	return callDO<LockoutAdmitResult>(namespace, loginKey(username), { op: "lockoutAdmit", maxAttempts, windowMs });
}

/**
 * Atomic KV read-modify-write for one account record (#84). Keyed by the account's
 * own KV key (distinct from the `login:*` id space above), so account mutations and
 * login-lockout counters for the same user serialise independently of each other.
 */
export async function atomicKvMerge(
	namespace: DurableObjectNamespace,
	kvKey: string,
	patch: Record<string, unknown>,
	options: { requireExisting: boolean; bumpField?: string },
): Promise<KvMergeResult> {
	return callDO<KvMergeResult>(namespace, kvKey, {
		op: "kvMerge",
		kvKey,
		patch,
		requireExisting: options.requireExisting,
		bumpField: options.bumpField,
	});
}

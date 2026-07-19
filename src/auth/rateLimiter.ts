/**
 * Atomic rate-limit / lockout counters backed by a Durable Object (suxos-net#35).
 * Also backs the atomic account-mutation ops below (#84).
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
 * WHY account mutations (create/resetPassword/revokeSessions) also route through
 * here (#84): those were plain KV get-then-put in src/auth/store.ts, the same TOCTOU
 * shape as the pre-#35 counters — two concurrent admin actions on one username (e.g.
 * a password reset racing a revoke-sessions call) could each read a stale Account and
 * one write's sessionEpoch/passwordHash silently clobbers the other's. Doing the
 * read-modify-write inside the DO's fetch handler (keyed by the account's KV key, so
 * it never collides with the `login:`-prefixed lockout instances above) serialises it
 * the same way; env.NAV_CACHE is threaded into the DO purely as a KV client, not a
 * migration of storage backend — reads (getAccount) stay direct KV, only the three
 * writes need the atomicity.
 */

import { hashPassword, type PasswordHash } from "./crypto";

export interface Account {
	username: string;
	passwordHash: PasswordHash;
	createdAt: string;
	// Session generation counter (#81). See src/auth/session.ts / src/auth/routes.ts.
	sessionEpoch: number;
}

const ACCOUNT_KEY_PREFIX = "auth:account:";

export function accountKey(username: string): string {
	return ACCOUNT_KEY_PREFIX + username.trim().toLowerCase();
}

export interface RateLimiterEnv {
	NAV_CACHE: KVNamespace;
}

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
interface AccountCreateRequest {
	op: "accountCreate";
	username: string;
	password: string;
}
interface AccountResetPasswordRequest {
	op: "accountResetPassword";
	username: string;
	newPassword: string;
}
interface AccountRevokeSessionsRequest {
	op: "accountRevokeSessions";
	username: string;
}
type RateLimiterRequest =
	| FixedWindowRequest
	| LockoutStatusRequest
	| LockoutRecordRequest
	| LockoutClearRequest
	| LockoutAdmitRequest
	| AccountCreateRequest
	| AccountResetPasswordRequest
	| AccountRevokeSessionsRequest;

export interface LockoutStatus {
	locked: boolean;
	retryAfterMs?: number;
}

export interface LockoutAdmitResult {
	admitted: boolean;
	retryAfterMs?: number;
}

export type CreateAccountResult = { ok: true } | { ok: false; error: string };
export type ResetPasswordResult = { ok: true } | { ok: false; error: string };
export type RevokeSessionsResult = { ok: true } | { ok: false; error: string };

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
	private readonly kv: KVNamespace;

	constructor(ctx: DurableObjectState, env: RateLimiterEnv) {
		this.storage = ctx.storage;
		this.kv = env.NAV_CACHE;
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
			case "accountCreate":
				return Response.json(await this.accountCreate(body.username, body.password));
			case "accountResetPassword":
				return Response.json(await this.accountResetPassword(body.username, body.newPassword));
			case "accountRevokeSessions":
				return Response.json(await this.accountRevokeSessions(body.username));
			case "lockoutClear":
				await this.storage.delete(LOCKOUT_SLOT);
				return Response.json({ ok: true });
			case "lockoutAdmit":
				return Response.json(await this.lockoutAdmit(body.maxAttempts, body.windowMs));
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

	private async getAccount(username: string): Promise<Account | null> {
		const raw = await this.kv.get(accountKey(username));
		if (!raw) return null;
		return JSON.parse(raw) as Account;
	}

	/** Mirrors the old store.ts createAccount, now serialised per-account (#84). */
	private async accountCreate(username: string, password: string): Promise<CreateAccountResult> {
		const trimmedUsername = username.trim();
		if (trimmedUsername.length === 0) return { ok: false, error: "username must not be empty" };
		if (password.length < 8) return { ok: false, error: "password must be at least 8 characters" };

		const existing = await this.getAccount(trimmedUsername);
		if (existing) return { ok: false, error: "account already exists" };

		const passwordHash = await hashPassword(password);
		const account: Account = {
			username: trimmedUsername.toLowerCase(),
			passwordHash,
			createdAt: new Date().toISOString(),
			sessionEpoch: 0,
		};
		await this.kv.put(accountKey(trimmedUsername), JSON.stringify(account));
		return { ok: true };
	}

	/** Mirrors the old store.ts resetPassword, now serialised per-account (#84). */
	private async accountResetPassword(username: string, newPassword: string): Promise<ResetPasswordResult> {
		if (newPassword.length < 8) return { ok: false, error: "password must be at least 8 characters" };

		const existing = await this.getAccount(username);
		if (!existing) return { ok: false, error: "account not found" };

		const passwordHash = await hashPassword(newPassword);
		const updated: Account = { ...existing, passwordHash, sessionEpoch: (existing.sessionEpoch ?? 0) + 1 };
		await this.kv.put(accountKey(username), JSON.stringify(updated));
		return { ok: true };
	}

	/** Mirrors the old store.ts revokeSessions, now serialised per-account (#84). */
	private async accountRevokeSessions(username: string): Promise<RevokeSessionsResult> {
		const existing = await this.getAccount(username);
		if (!existing) return { ok: false, error: "account not found" };

		const updated: Account = { ...existing, sessionEpoch: (existing.sessionEpoch ?? 0) + 1 };
		await this.kv.put(accountKey(username), JSON.stringify(updated));
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

// --- Account mutation client helpers (#84). Keyed by the account's own KV key (not
// `login:`), so an account's create/reset/revoke instance is distinct from its login
// lockout instance — one DO instance per account still serialises all three against
// each other, which is the whole fix for the read-then-put race between them. ---

export async function createAccountAtomic(
	namespace: DurableObjectNamespace,
	username: string,
	password: string,
): Promise<CreateAccountResult> {
	return callDO<CreateAccountResult>(namespace, accountKey(username), { op: "accountCreate", username, password });
}

export async function resetPasswordAtomic(
	namespace: DurableObjectNamespace,
	username: string,
	newPassword: string,
): Promise<ResetPasswordResult> {
	return callDO<ResetPasswordResult>(namespace, accountKey(username), { op: "accountResetPassword", username, newPassword });
}

export async function revokeSessionsAtomic(
	namespace: DurableObjectNamespace,
	username: string,
): Promise<RevokeSessionsResult> {
	return callDO<RevokeSessionsResult>(namespace, accountKey(username), { op: "accountRevokeSessions", username });
}

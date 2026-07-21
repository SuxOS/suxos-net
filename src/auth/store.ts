/**
 * Durable account storage for recipient logins (#18) — KV-backed (same store class
 * as the audit log work, #20/#23; see docs design §1/§5). Reuses the existing
 * NAV_CACHE KV namespace with a distinct key prefix rather than provisioning a new
 * Cloudflare KV namespace for this staging Worker — KV namespaces are flat key
 * spaces, so a prefix gives the same isolation a dedicated namespace would, without
 * an extra piece of live cloud infrastructure to provision/track for a staging repo
 * that may still change shape. Revisit if/when this needs its own namespace (e.g. a
 * production cutover with different retention/backup requirements than NAV_CACHE).
 *
 * One real record per recipient, created only via the operator-only admin routes in
 * src/auth/routes.ts — there is no self-serve signup path anywhere in this module.
 */

import { hashPassword, type PasswordHash } from "./crypto";
import { admitLoginAttempt as admitLoginAttemptDO, atomicKvMerge, clearLockout, type LockoutAdmitResult } from "./rateLimiter";

const ACCOUNT_KEY_PREFIX = "auth:account:";

export interface Account {
	username: string;
	passwordHash: PasswordHash;
	createdAt: string;
	// Session generation counter (#81). Embedded in every session token minted for
	// this account (src/auth/session.ts) and compared against on every authenticated
	// request (requireSession, src/auth/routes.ts) — bumping it invalidates every
	// token minted under an older value, independent of that token's natural 24h
	// expiry. Defaults to 0 for accounts created before this field existed (an absent
	// field reads back as `undefined`, which callers normalise to 0).
	sessionEpoch: number;
}

function accountKey(username: string): string {
	return ACCOUNT_KEY_PREFIX + username.trim().toLowerCase();
}

export async function getAccount(kv: KVNamespace, username: string): Promise<Account | null> {
	const raw = await kv.get(accountKey(username));
	if (!raw) return null;
	return JSON.parse(raw) as Account;
}

export interface AccountSummary {
	username: string;
	createdAt: string;
	sessionEpoch: number;
}

export interface ListAccountsResult {
	accounts: AccountSummary[];
	cursor: string | null;
}

// Same bound as listReferences (src/references/store.ts) and listAuditLog
// (src/audit/log.ts) — one list call's KV reads stay capped regardless of caller-supplied limit.
const MAX_LIST_LIMIT = 200;

/**
 * Operator-only: lists accounts (#96), never the password hash — just enough for an
 * operator to find a username to reset/revoke without already knowing it from
 * outside the system. Same kv.list cursor-pagination shape as listReferences.
 */
export async function listAccounts(kv: KVNamespace, limit = MAX_LIST_LIMIT, cursor?: string): Promise<ListAccountsResult> {
	const boundedLimit = Math.min(Math.max(1, limit), MAX_LIST_LIMIT);
	const page = await kv.list({ prefix: ACCOUNT_KEY_PREFIX, limit: boundedLimit, cursor });
	const accounts = await Promise.all(
		page.keys.map(async (key): Promise<AccountSummary | null> => {
			const raw = await kv.get(key.name);
			if (!raw) return null;
			const account = JSON.parse(raw) as Account;
			return { username: account.username, createdAt: account.createdAt, sessionEpoch: account.sessionEpoch ?? 0 };
		}),
	);
	return {
		accounts: accounts.filter((account): account is AccountSummary => account !== null),
		cursor: page.list_complete ? null : (page.cursor ?? null),
	};
}

export type CreateAccountResult = { ok: true } | { ok: false; error: string };

/**
 * Operator-only: creates one account for one recipient. Never invoked from a public
 * self-serve route — always from the admin surface behind assertStagingAccess (and,
 * in a real deployment, behind the operator's Cloudflare Access gate, unchanged).
 *
 * Routed through the RateLimiterDO's atomic "kvMerge" op (#84) rather than a plain
 * kv.get-then-put: two concurrent create calls for the same new username used to be
 * able to both read "not found" and each write, silently letting the second overwrite
 * the first (whichever password won was undefined/racy). The DO serialises this
 * exists-check-and-write per account key.
 */
export async function createAccount(
	rateLimiter: DurableObjectNamespace,
	username: string,
	password: string,
): Promise<CreateAccountResult> {
	const trimmedUsername = username.trim();
	if (trimmedUsername.length === 0) return { ok: false, error: "username must not be empty" };
	if (password.length < 8) return { ok: false, error: "password must be at least 8 characters" };

	const passwordHash = await hashPassword(password);
	const patch: Omit<Account, "sessionEpoch"> = {
		username: trimmedUsername.toLowerCase(),
		passwordHash,
		createdAt: new Date().toISOString(),
	};
	const result = await atomicKvMerge(rateLimiter, accountKey(trimmedUsername), { ...patch, sessionEpoch: 0 }, { requireExisting: false });
	if (!result.ok) return { ok: false, error: "account already exists" };
	return { ok: true };
}

export type ResetPasswordResult = { ok: true } | { ok: false; error: string };

/**
 * Operator-only direct password reset — no email-based reset flow (design §1).
 * Also bumps sessionEpoch (#81): a stolen/still-live session cookie must not
 * survive the very reset that's meant to lock its holder out. Without this, a
 * reset only changed the password hash — any session token minted before the
 * reset kept verifying successfully for up to 24h more.
 *
 * Routed through the RateLimiterDO's atomic "kvMerge" op (#84): a reset racing a
 * revoke-sessions call (or another reset) for the same account used to each read a
 * stale copy and one write could clobber the other's sessionEpoch bump. The DO's
 * bumpField increments off the value it itself just read, inside one serialised turn.
 */
export async function resetPassword(
	rateLimiter: DurableObjectNamespace,
	username: string,
	newPassword: string,
): Promise<ResetPasswordResult> {
	if (newPassword.length < 8) return { ok: false, error: "password must be at least 8 characters" };

	const passwordHash = await hashPassword(newPassword);
	const result = await atomicKvMerge(rateLimiter, accountKey(username), { passwordHash }, { requireExisting: true, bumpField: "sessionEpoch" });
	if (!result.ok) return { ok: false, error: "account not found" };
	return { ok: true };
}

export type RevokeSessionsResult = { ok: true } | { ok: false; error: string };

/**
 * Force logout for one recipient (#81) — bumps sessionEpoch without touching the
 * password, so every session token minted before this call fails its next epoch
 * check (requireSession, src/auth/routes.ts) regardless of expiry. Used both by the
 * operator-only "force logout this recipient" admin action and by the
 * recipient-facing self-service "log out everywhere" (#83) — same primitive, either
 * an operator or the account's own authenticated owner may trigger it.
 *
 * Routed through the RateLimiterDO's atomic "kvMerge" op (#84) — see resetPassword's
 * doc comment for why a plain kv.get-then-put here was racy.
 */
export async function revokeSessions(rateLimiter: DurableObjectNamespace, username: string): Promise<RevokeSessionsResult> {
	const result = await atomicKvMerge(rateLimiter, accountKey(username), {}, { requireExisting: true, bumpField: "sessionEpoch" });
	if (!result.ok) return { ok: false, error: "account not found" };
	return { ok: true };
}

// --- Login rate limiting / lockout (also closes the general "no rate limiting on
// login" gap flagged in the org security audit).
//
// The per-username lockout counter lives in the RateLimiterDO Durable Object
// (src/auth/rateLimiter.ts), NOT KV. KV has no atomic increment, so the previous
// get-then-put here was a TOCTOU race: concurrent failed logins could all read the
// same pre-increment count and never trip the 5-attempt threshold (security-review
// HIGH on #35). Routing through the DO makes increment-and-check atomic — the budget
// (5 attempts / 15 min) and the lock-from-tripping-attempt semantics are unchanged;
// only the store backing them moved from KV to the serialised DO. Accounts stay in
// KV (no atomicity requirement — one operator-only writer). ---

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

export type { LockoutAdmitResult };

/**
 * Atomically count one login attempt and decide if it may proceed to a password verify.
 * This is the login path's ONLY lockout gate — it must be called at handler entry
 * (before the PBKDF2 verify), because counting-and-deciding in one atomic DO op is what
 * closes the concurrent-burst race that a separate check-then-record could not (#35).
 */
export async function admitLoginAttempt(rateLimiter: DurableObjectNamespace, username: string): Promise<LockoutAdmitResult> {
	return admitLoginAttemptDO(rateLimiter, username, MAX_FAILED_ATTEMPTS, LOCKOUT_WINDOW_MS);
}

export async function clearFailedAttempts(rateLimiter: DurableObjectNamespace, username: string): Promise<void> {
	await clearLockout(rateLimiter, username);
}

export const AUTH_LOCKOUT_CONSTANTS = { MAX_FAILED_ATTEMPTS, LOCKOUT_WINDOW_MS };

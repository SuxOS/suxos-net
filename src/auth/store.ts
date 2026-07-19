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
 *
 * Mutations (create/resetPassword/revokeSessions) are routed through the
 * RateLimiterDO (src/auth/rateLimiter.ts, #84) so concurrent writes to the same
 * account can't race each other via a stale get-then-put; getAccount stays a direct,
 * unserialised KV read since reads don't need the same guarantee.
 */

import {
	accountKey,
	admitLoginAttempt as admitLoginAttemptDO,
	clearLockout,
	createAccountAtomic,
	getLockoutStatus,
	type Account,
	type CreateAccountResult,
	type LockoutAdmitResult,
	type LockoutStatus,
	type ResetPasswordResult,
	type RevokeSessionsResult,
	recordLockoutFailure,
	resetPasswordAtomic,
	revokeSessionsAtomic,
} from "./rateLimiter";

export type { Account, CreateAccountResult, ResetPasswordResult, RevokeSessionsResult };

export async function getAccount(kv: KVNamespace, username: string): Promise<Account | null> {
	const raw = await kv.get(accountKey(username));
	if (!raw) return null;
	return JSON.parse(raw) as Account;
}

/**
 * Operator-only: creates one account for one recipient. Never invoked from a public
 * self-serve route — always from the admin surface behind assertStagingAccess (and,
 * in a real deployment, behind the operator's Cloudflare Access gate, unchanged).
 *
 * Routed through the RateLimiterDO (#84): a plain KV get-then-put here raced with
 * concurrent resetPassword/revokeSessions calls on the same username (each could read
 * a stale Account and clobber the other's write). The DO serialises all three
 * mutations per-account — see src/auth/rateLimiter.ts.
 */
export async function createAccount(
	rateLimiter: DurableObjectNamespace,
	username: string,
	password: string,
): Promise<CreateAccountResult> {
	return createAccountAtomic(rateLimiter, username, password);
}

/**
 * Operator-only direct password reset — no email-based reset flow (design §1).
 * Also bumps sessionEpoch (#81): a stolen/still-live session cookie must not
 * survive the very reset that's meant to lock its holder out. Without this, a
 * reset only changed the password hash — any session token minted before the
 * reset kept verifying successfully for up to 24h more. Routed through the
 * RateLimiterDO (#84) for the same atomicity reason as createAccount above.
 */
export async function resetPassword(
	rateLimiter: DurableObjectNamespace,
	username: string,
	newPassword: string,
): Promise<ResetPasswordResult> {
	return resetPasswordAtomic(rateLimiter, username, newPassword);
}

/**
 * Operator-only "force logout this recipient" (#81) — bumps sessionEpoch without
 * touching the password, so every session token minted before this call fails its
 * next epoch check (requireSession, src/auth/routes.ts) regardless of expiry. This
 * is the incident-response action for "I don't want to reset the password, I just
 * want every current session dead" (e.g. a shared/logged-in device was lost).
 * Routed through the RateLimiterDO (#84) for the same atomicity reason as
 * createAccount above.
 */
export async function revokeSessions(rateLimiter: DurableObjectNamespace, username: string): Promise<RevokeSessionsResult> {
	return revokeSessionsAtomic(rateLimiter, username);
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
// only the store backing them moved from KV to the serialised DO. Account mutations
// (create/resetPassword/revokeSessions, above) are now also routed through the DO for
// the same reason (#84) — reads (getAccount) stay a direct, unserialised KV get. ---

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

export type { LockoutAdmitResult, LockoutStatus };

/**
 * Atomically count one login attempt and decide if it may proceed to a password verify.
 * This is the login path's ONLY lockout gate — it must be called at handler entry
 * (before the PBKDF2 verify), because counting-and-deciding in one atomic DO op is what
 * closes the concurrent-burst race that a separate check-then-record could not (#35).
 */
export async function admitLoginAttempt(rateLimiter: DurableObjectNamespace, username: string): Promise<LockoutAdmitResult> {
	return admitLoginAttemptDO(rateLimiter, username, MAX_FAILED_ATTEMPTS, LOCKOUT_WINDOW_MS);
}

export async function checkLockout(rateLimiter: DurableObjectNamespace, username: string): Promise<LockoutStatus> {
	return getLockoutStatus(rateLimiter, username);
}

export async function recordFailedAttempt(rateLimiter: DurableObjectNamespace, username: string): Promise<void> {
	await recordLockoutFailure(rateLimiter, username, MAX_FAILED_ATTEMPTS, LOCKOUT_WINDOW_MS);
}

export async function clearFailedAttempts(rateLimiter: DurableObjectNamespace, username: string): Promise<void> {
	await clearLockout(rateLimiter, username);
}

export const AUTH_LOCKOUT_CONSTANTS = { MAX_FAILED_ATTEMPTS, LOCKOUT_WINDOW_MS };

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
import {
	admitLoginAttempt as admitLoginAttemptDO,
	clearLockout,
	getLockoutStatus,
	type LockoutAdmitResult,
	type LockoutStatus,
	recordLockoutFailure,
} from "./rateLimiter";

const ACCOUNT_KEY_PREFIX = "auth:account:";

export interface Account {
	username: string;
	passwordHash: PasswordHash;
	createdAt: string;
}

function accountKey(username: string): string {
	return ACCOUNT_KEY_PREFIX + username.trim().toLowerCase();
}

export async function getAccount(kv: KVNamespace, username: string): Promise<Account | null> {
	const raw = await kv.get(accountKey(username));
	if (!raw) return null;
	return JSON.parse(raw) as Account;
}

export type CreateAccountResult = { ok: true } | { ok: false; error: string };

/**
 * Operator-only: creates one account for one recipient. Never invoked from a public
 * self-serve route — always from the admin surface behind assertStagingAccess (and,
 * in a real deployment, behind the operator's Cloudflare Access gate, unchanged).
 */
export async function createAccount(kv: KVNamespace, username: string, password: string): Promise<CreateAccountResult> {
	const trimmedUsername = username.trim();
	if (trimmedUsername.length === 0) return { ok: false, error: "username must not be empty" };
	if (password.length < 8) return { ok: false, error: "password must be at least 8 characters" };

	const existing = await getAccount(kv, trimmedUsername);
	if (existing) return { ok: false, error: "account already exists" };

	const passwordHash = await hashPassword(password);
	const account: Account = {
		username: trimmedUsername.toLowerCase(),
		passwordHash,
		createdAt: new Date().toISOString(),
	};
	await kv.put(accountKey(trimmedUsername), JSON.stringify(account));
	return { ok: true };
}

export type ResetPasswordResult = { ok: true } | { ok: false; error: string };

/** Operator-only direct password reset — no email-based reset flow (design §1). */
export async function resetPassword(kv: KVNamespace, username: string, newPassword: string): Promise<ResetPasswordResult> {
	if (newPassword.length < 8) return { ok: false, error: "password must be at least 8 characters" };

	const existing = await getAccount(kv, username);
	if (!existing) return { ok: false, error: "account not found" };

	const passwordHash = await hashPassword(newPassword);
	const updated: Account = { ...existing, passwordHash };
	await kv.put(accountKey(username), JSON.stringify(updated));
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

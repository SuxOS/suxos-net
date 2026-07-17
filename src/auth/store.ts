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

const ACCOUNT_KEY_PREFIX = "auth:account:";
const LOCKOUT_KEY_PREFIX = "auth:lockout:";

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
// login" gap flagged in the org security audit) ---

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_WINDOW_MS = 15 * 60 * 1000;

interface LockoutState {
	failedAttempts: number;
	windowStartedAt: number;
	lockedUntil?: number;
}

function lockoutKey(username: string): string {
	return LOCKOUT_KEY_PREFIX + username.trim().toLowerCase();
}

export interface LockoutStatus {
	locked: boolean;
	retryAfterMs?: number;
}

export async function checkLockout(kv: KVNamespace, username: string, now: number = Date.now()): Promise<LockoutStatus> {
	const raw = await kv.get(lockoutKey(username));
	if (!raw) return { locked: false };
	const state = JSON.parse(raw) as LockoutState;
	if (state.lockedUntil && now < state.lockedUntil) {
		return { locked: true, retryAfterMs: state.lockedUntil - now };
	}
	return { locked: false };
}

export async function recordFailedAttempt(kv: KVNamespace, username: string, now: number = Date.now()): Promise<void> {
	const key = lockoutKey(username);
	const raw = await kv.get(key);
	let state: LockoutState = raw ? (JSON.parse(raw) as LockoutState) : { failedAttempts: 0, windowStartedAt: now };

	if (now - state.windowStartedAt > LOCKOUT_WINDOW_MS) {
		state = { failedAttempts: 0, windowStartedAt: now };
	}

	state.failedAttempts += 1;
	if (state.failedAttempts >= MAX_FAILED_ATTEMPTS) {
		state.lockedUntil = now + LOCKOUT_WINDOW_MS;
	}

	await kv.put(key, JSON.stringify(state));
}

export async function clearFailedAttempts(kv: KVNamespace, username: string): Promise<void> {
	await kv.delete(lockoutKey(username));
}

export const AUTH_LOCKOUT_CONSTANTS = { MAX_FAILED_ATTEMPTS, LOCKOUT_WINDOW_MS };

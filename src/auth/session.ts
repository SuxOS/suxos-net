/**
 * Signed session tokens for recipient logins (#18). HMAC-SHA256 over a session
 * identity + expiry, using a server-side secret (env.SESSION_SECRET, set via
 * `wrangler secret put SESSION_SECRET` — never a `vars` entry, never committed).
 * Delivered as an HttpOnly, Secure, SameSite=Strict cookie — never a bearer token
 * in localStorage/JS-readable storage, to avoid XSS-exfiltration of the session.
 */

import { fromHex, timingSafeEqual, toHex } from "./crypto";

export const SESSION_COOKIE_NAME = "suxos_session";

// 24h, matching the existing Cloudflare Access session_duration for consistency
// between the operator's Access session and a recipient's login session.
export const SESSION_DURATION_MS = 24 * 60 * 60 * 1000;

export interface SessionPayload {
	username: string;
	epoch: number;
	expiresAt: number;
}

/**
 * Fail CLOSED when SESSION_SECRET is unset/empty (mirrors OPERATOR_TOKEN's guard in
 * routes.ts). An empty HMAC key is a well-known constant, so signing sessions with it
 * would let anyone forge a valid cookie for any username and bypass the recipient-auth
 * gate entirely (suxos-net#35 security-review HIGH). Sign-side throws (never issue a
 * forgeable token); verify-side rejects (never accept one).
 */
function assertSessionSecret(secret: string): void {
	if (!secret) {
		throw new Error(
			"SESSION_SECRET is not configured — refusing to sign a session token with an empty key. Set it via `wrangler secret put SESSION_SECRET`.",
		);
	}
}

async function hmacSha256Hex(secret: string, data: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
		"sign",
	]);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
	return toHex(sig);
}

/**
 * Token shape: `<username>.<epoch>.<expiresAtMs>.<hmacHex>`. The username, epoch, and
 * expiry are plaintext (not secret — the cookie is HttpOnly so JS can't read it
 * anyway) but the signature over all three prevents forging or extending a session,
 * or replaying it under a stale epoch, without the secret.
 *
 * `epoch` is the account's session generation counter (src/auth/store.ts's
 * `sessionEpoch`, #81) at the moment this token was minted. requireSession
 * (src/auth/routes.ts) compares it against the account's CURRENT epoch on every
 * request; a password reset or an explicit "revoke sessions" admin action bumps the
 * stored epoch, which instantly invalidates every token minted under an older one —
 * the primitive this repo had no way to express before (self-contained signed tokens
 * had no server-side state to revoke).
 *
 * Usernames may contain dots (e.g. `jane.doe` — a normal operator choice, see #80),
 * so parsing can't split on "." and require exactly N parts: that rejected every
 * dotted username as malformed. Instead parse from the RIGHT — the trailing epoch,
 * expiry, and signature are always plain digits/hex with no dots — and treat
 * whatever dot-delimited segments remain, however many there are, as the username.
 */
export async function createSessionToken(
	username: string,
	secret: string,
	epoch: number = 0,
	now: number = Date.now(),
): Promise<string> {
	assertSessionSecret(secret);
	const expiresAt = now + SESSION_DURATION_MS;
	const payload = `${username}.${epoch}.${expiresAt}`;
	const signature = await hmacSha256Hex(secret, payload);
	return `${payload}.${signature}`;
}

export async function verifySessionToken(
	token: string,
	secret: string,
	now: number = Date.now(),
): Promise<SessionPayload | null> {
	// Fail closed: with no secret, verification would accept a signature computed under
	// the well-known empty key — reject every session instead (suxos-net#35 HIGH).
	if (!secret) return null;

	// Parse from the right: last segment is the signature, then expiry, then epoch —
	// everything before that (rejoined with ".") is the username, however many dots it
	// contains (suxos-net#80). Fewer than 4 total segments means there's no room left
	// for a non-empty username, so it's malformed.
	const parts = token.split(".");
	if (parts.length < 4) return null;
	const signatureHex = parts[parts.length - 1];
	const expiresAtRaw = parts[parts.length - 2];
	const epochRaw = parts[parts.length - 3];
	const username = parts.slice(0, parts.length - 3).join(".");
	if (!username || !expiresAtRaw || !signatureHex || !epochRaw) return null;

	const expiresAt = Number(expiresAtRaw);
	if (!Number.isFinite(expiresAt)) return null;
	const epoch = Number(epochRaw);
	if (!Number.isFinite(epoch)) return null;

	const expectedSignatureHex = await hmacSha256Hex(secret, `${username}.${epochRaw}.${expiresAtRaw}`);

	let signatureBytes: Uint8Array;
	let expectedBytes: Uint8Array;
	try {
		signatureBytes = fromHex(signatureHex);
		expectedBytes = fromHex(expectedSignatureHex);
	} catch {
		return null;
	}
	// Timing-safe: never `===` a signature against an attacker-suppliable value.
	if (!timingSafeEqual(signatureBytes, expectedBytes)) return null;

	if (now > expiresAt) return null;

	return { username, epoch, expiresAt };
}

export function buildSessionCookie(token: string): string {
	const maxAgeSeconds = Math.floor(SESSION_DURATION_MS / 1000);
	return `${SESSION_COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}`;
}

export function buildLogoutCookie(): string {
	return `${SESSION_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

export function extractSessionToken(request: Request): string | null {
	const cookieHeader = request.headers.get("Cookie") ?? request.headers.get("cookie");
	if (!cookieHeader) return null;
	for (const part of cookieHeader.split(";")) {
		const trimmed = part.trim();
		if (trimmed.startsWith(`${SESSION_COOKIE_NAME}=`)) {
			return trimmed.slice(SESSION_COOKIE_NAME.length + 1);
		}
	}
	return null;
}

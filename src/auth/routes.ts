/**
 * HTTP handlers for recipient login/session and operator-only account admin (#18).
 * Wired into src/index.ts. No route in this file is self-serve signup — /login only
 * verifies an existing account, and the /admin/* routes are for the operator only.
 * Operator routes independently require a bearer OPERATOR_TOKEN (see assertOperator):
 * the Worker never assumes a Cloudflare Access edge exists in front of it, so admin
 * provisioning/reset is safe even on a bare `*.workers.dev` deployment.
 */

import { timingSafeEqual, verifyPasswordConstantTime } from "./crypto";
import { recipientIdentity } from "./identity";
import { buildLogoutCookie, buildSessionCookie, createSessionToken, extractSessionToken, verifySessionToken } from "./session";
import { admitLoginAttempt, clearFailedAttempts, createAccount, getAccount, resetPassword } from "./store";
import { readJsonBodyWithLimit } from "../httpBody";

export interface AuthEnv {
	NAV_CACHE: KVNamespace;
	// Durable Object namespace backing the atomic per-username login lockout counter
	// (#35). KV has no atomic increment, so the lockout lives in a serialised DO —
	// see src/auth/rateLimiter.ts and src/auth/store.ts.
	RATE_LIMITER: DurableObjectNamespace;
	SESSION_SECRET: string;
	// Shared secret for operator-only /admin/* routes. Set via
	// `wrangler secret put OPERATOR_TOKEN` — never a `vars` entry, never committed.
	// When unset, assertOperator fails closed (every admin request → 401).
	OPERATOR_TOKEN: string;
}

interface ApiError {
	error: string;
	field?: string;
}

function jsonResponse(status: number, body: unknown, extraHeaders?: HeadersInit): Response {
	return Response.json(body, { status, headers: extraHeaders });
}

function errorResponse(status: number, body: ApiError, extraHeaders?: HeadersInit): Response {
	return jsonResponse(status, body, extraHeaders);
}

async function parseJsonBody(request: Request): Promise<{ body: Record<string, unknown> } | { error: Response }> {
	const contentType = request.headers.get("content-type") ?? "";
	if (!contentType.includes("application/json")) {
		return { error: errorResponse(400, { error: "expected Content-Type: application/json", field: "content-type" }) };
	}
	const bodyResult = await readJsonBodyWithLimit(request);
	if (!bodyResult.ok) {
		if (bodyResult.kind === "too-large") {
			return { error: errorResponse(413, { error: `request body exceeds ${bodyResult.maxBytes} byte limit` }) };
		}
		return { error: errorResponse(400, { error: "request body must be valid JSON" }) };
	}
	const parsed = bodyResult.parsed;
	if (typeof parsed !== "object" || parsed === null) {
		return { error: errorResponse(400, { error: "request body must be a JSON object" }) };
	}
	return { body: parsed as Record<string, unknown> };
}

function extractUsernamePassword(body: Record<string, unknown>): { username: string; password: string } | { error: Response } {
	const { username, password } = body;
	if (typeof username !== "string" || username.trim().length === 0) {
		return { error: errorResponse(400, { error: "missing or non-string username", field: "username" }) };
	}
	if (typeof password !== "string" || password.length === 0) {
		return { error: errorResponse(400, { error: "missing or non-string password", field: "password" }) };
	}
	return { username, password };
}

/** POST /login — the only authentication entry point for recipients. */
export async function handleLogin(request: Request, env: AuthEnv): Promise<Response> {
	if (request.method !== "POST") return errorResponse(405, { error: "method not allowed, expected POST" }, { Allow: "POST" });

	const parsedBody = await parseJsonBody(request);
	if ("error" in parsedBody) return parsedBody.error;
	const parsed = extractUsernamePassword(parsedBody.body);
	if ("error" in parsed) return parsed.error;
	const { username, password } = parsed;

	// Atomic admission gate: count this attempt AND decide, in one DO op, BEFORE the
	// expensive PBKDF2 verify below. A concurrent burst against one username is therefore
	// serialised into distinct sequential counts — at most MAX_FAILED_ATTEMPTS reach the
	// verify, the rest are locked out here. (The old split check-then-record straddled the
	// verify and let a burst slip past — suxos-net#35 residual HIGH.)
	const admit = await admitLoginAttempt(env.RATE_LIMITER, username);
	if (!admit.admitted) {
		const retryAfterSeconds = Math.ceil((admit.retryAfterMs ?? 0) / 1000);
		return errorResponse(429, { error: "too many failed login attempts; try again later" }, {
			"Retry-After": String(retryAfterSeconds),
		});
	}

	const account = await getAccount(env.NAV_CACHE, username);
	// Same generic message whether the account doesn't exist or the password is
	// wrong — never leak which case it was (avoids username enumeration).
	const genericFailure = () => errorResponse(401, { error: "invalid username or password" });

	// Always run exactly one full-cost PBKDF2 verify, even when the account does
	// not exist (verifyPasswordConstantTime falls back to a decoy hash of identical
	// cost). This keeps the "no such user" path the same observable work/latency as
	// the "wrong password" path, closing the username-enumeration timing side-channel.
	const valid = await verifyPasswordConstantTime(password, account?.passwordHash ?? null);
	if (!account || !valid) {
		// The attempt was already counted atomically at admission above — no separate
		// record step (that split was the race). A wrong guess simply falls through.
		return genericFailure();
	}

	await clearFailedAttempts(env.RATE_LIMITER, username);
	const token = await createSessionToken(account.username, env.SESSION_SECRET);
	return jsonResponse(
		200,
		{ ok: true, username: account.username, identity: recipientIdentity(account.username) },
		{ "Set-Cookie": buildSessionCookie(token) },
	);
}

/** POST /logout — clears the session cookie. No server-side session state to revoke
 * (the token is self-contained/signed), so this simply tells the client to drop it;
 * the token itself remains valid until its natural expiry if replayed. */
export async function handleLogout(request: Request): Promise<Response> {
	if (request.method !== "POST") return errorResponse(405, { error: "method not allowed, expected POST" }, { Allow: "POST" });
	return jsonResponse(200, { ok: true }, { "Set-Cookie": buildLogoutCookie() });
}

/**
 * Verifies the session cookie's signature and expiry. Returns the authenticated
 * username, or null if there is no valid session — callers treat null as
 * unauthenticated (401). Intended to run on every request to a protected route.
 */
export async function requireSession(request: Request, env: AuthEnv): Promise<string | null> {
	const token = extractSessionToken(request);
	if (!token) return null;
	const payload = await verifySessionToken(token, env.SESSION_SECRET);
	if (!payload) return null;
	return payload.username;
}

export function unauthorizedResponse(): Response {
	return errorResponse(401, { error: "authentication required" }, { "WWW-Authenticate": "Cookie" });
}

function operatorUnauthorizedResponse(): Response {
	return errorResponse(401, { error: "operator authentication required" }, { "WWW-Authenticate": "Bearer" });
}

/** Extracts the token from an `Authorization: Bearer <token>` header, or null. */
function extractBearerToken(request: Request): string | null {
	const header = request.headers.get("Authorization");
	if (!header) return null;
	const match = /^Bearer (.+)$/.exec(header);
	return match ? match[1] : null;
}

/**
 * Gate for operator-only /admin/* routes. Requires an `Authorization: Bearer` token
 * that constant-time-matches env.OPERATOR_TOKEN. Fails CLOSED when the token is unset
 * or missing — an unconfigured Worker rejects every admin request rather than exposing
 * account provisioning/reset. Both sides are SHA-256'd to fixed 32-byte digests before
 * comparison so timingSafeEqual never leaks token length. Returns a 401 Response to
 * short-circuit the handler, or null when the caller is a verified operator. Exported
 * so other operator-only admin routes (e.g. the audit-log read view, #20) reuse this
 * exact check instead of re-implementing the constant-time comparison.
 */
export async function assertOperator(request: Request, env: AuthEnv): Promise<Response | null> {
	const provided = extractBearerToken(request);
	if (!env.OPERATOR_TOKEN || !provided) return operatorUnauthorizedResponse();
	const encoder = new TextEncoder();
	const providedDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(provided)));
	const expectedDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(env.OPERATOR_TOKEN)));
	if (!timingSafeEqual(providedDigest, expectedDigest)) return operatorUnauthorizedResponse();
	return null;
}

/**
 * POST /admin/accounts — operator-only, creates one account for one recipient.
 * Never self-serve: requires a valid operator bearer token (assertOperator). A real
 * deployment may additionally front this with Cloudflare Access, but the token gate
 * stands on its own so a bare `*.workers.dev` deploy is not exposed.
 */
export async function handleAdminCreateAccount(request: Request, env: AuthEnv): Promise<Response> {
	if (request.method !== "POST") return errorResponse(405, { error: "method not allowed, expected POST" }, { Allow: "POST" });

	const denied = await assertOperator(request, env);
	if (denied) return denied;

	const parsedBody = await parseJsonBody(request);
	if ("error" in parsedBody) return parsedBody.error;
	const parsed = extractUsernamePassword(parsedBody.body);
	if ("error" in parsed) return parsed.error;
	const { username, password } = parsed;

	const result = await createAccount(env.NAV_CACHE, username, password);
	if (!result.ok) return errorResponse(409, { error: result.error });
	return jsonResponse(201, { ok: true, username: username.trim().toLowerCase() });
}

/** POST /admin/accounts/reset — operator-only direct password reset, no email flow. */
export async function handleAdminResetPassword(request: Request, env: AuthEnv): Promise<Response> {
	if (request.method !== "POST") return errorResponse(405, { error: "method not allowed, expected POST" }, { Allow: "POST" });

	const denied = await assertOperator(request, env);
	if (denied) return denied;

	const parsedBody = await parseJsonBody(request);
	if ("error" in parsedBody) return parsedBody.error;
	const parsed = extractUsernamePassword(parsedBody.body);
	if ("error" in parsed) return parsed.error;
	const { username, password } = parsed;

	const result = await resetPassword(env.NAV_CACHE, username, password);
	if (!result.ok) return errorResponse(404, { error: result.error });
	return jsonResponse(200, { ok: true });
}

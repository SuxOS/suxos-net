/**
 * HTTP handlers for recipient login/session and operator-only account admin (#18).
 * Wired into src/index.ts. No route in this file is self-serve signup — /login only
 * verifies an existing account, and the /admin/* routes are for the operator only
 * (reachable only behind the Worker-wide assertStagingAccess gate, which stands in
 * for the operator's Cloudflare Access gate in this staging deployment, unchanged).
 */

import { verifyPassword } from "./crypto";
import { recipientIdentity } from "./identity";
import { buildLogoutCookie, buildSessionCookie, createSessionToken, extractSessionToken, verifySessionToken } from "./session";
import { checkLockout, clearFailedAttempts, createAccount, getAccount, recordFailedAttempt, resetPassword } from "./store";

export interface AuthEnv {
	NAV_CACHE: KVNamespace;
	SESSION_SECRET: string;
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
	let parsed: unknown;
	try {
		parsed = await request.json();
	} catch {
		return { error: errorResponse(400, { error: "request body must be valid JSON" }) };
	}
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

	const lockout = await checkLockout(env.NAV_CACHE, username);
	if (lockout.locked) {
		const retryAfterSeconds = Math.ceil((lockout.retryAfterMs ?? 0) / 1000);
		return errorResponse(429, { error: "too many failed login attempts; try again later" }, {
			"Retry-After": String(retryAfterSeconds),
		});
	}

	const account = await getAccount(env.NAV_CACHE, username);
	// Same generic message whether the account doesn't exist or the password is
	// wrong — never leak which case it was (avoids username enumeration).
	const genericFailure = () => errorResponse(401, { error: "invalid username or password" });

	if (!account) {
		await recordFailedAttempt(env.NAV_CACHE, username);
		return genericFailure();
	}

	const valid = await verifyPassword(password, account.passwordHash);
	if (!valid) {
		await recordFailedAttempt(env.NAV_CACHE, username);
		return genericFailure();
	}

	await clearFailedAttempts(env.NAV_CACHE, username);
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

/**
 * POST /admin/accounts — operator-only, creates one account for one recipient.
 * Never self-serve: reachable only inside this staging Worker's existing
 * assertStagingAccess gate (real deployments front this with the operator's own
 * Cloudflare Access policy, unchanged — see src/index.ts).
 */
export async function handleAdminCreateAccount(request: Request, env: AuthEnv): Promise<Response> {
	if (request.method !== "POST") return errorResponse(405, { error: "method not allowed, expected POST" }, { Allow: "POST" });

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

	const parsedBody = await parseJsonBody(request);
	if ("error" in parsedBody) return parsedBody.error;
	const parsed = extractUsernamePassword(parsedBody.body);
	if ("error" in parsed) return parsed.error;
	const { username, password } = parsed;

	const result = await resetPassword(env.NAV_CACHE, username, password);
	if (!result.ok) return errorResponse(404, { error: result.error });
	return jsonResponse(200, { ok: true });
}

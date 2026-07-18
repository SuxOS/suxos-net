/**
 * Shared operator-bearer-token gate for every `/admin/*` route in this Worker —
 * originally lived only in auth/routes.ts (#18/#35), extracted so other admin
 * surfaces (e.g. trusted-reference curation, #19) enforce the exact same fail-closed
 * check rather than a re-implementation that could drift.
 */

export interface OperatorEnv {
	// Shared secret for operator-only /admin/* routes. Set via
	// `wrangler secret put OPERATOR_TOKEN` — never a `vars` entry, never committed.
	// When unset, assertOperator fails closed (every admin request → 401).
	OPERATOR_TOKEN: string;
}

function operatorUnauthorizedResponse(): Response {
	return Response.json({ error: "operator authentication required" }, { status: 401, headers: { "WWW-Authenticate": "Bearer" } });
}

/** Extracts the token from an `Authorization: Bearer <token>` header, or null. */
function extractBearerToken(request: Request): string | null {
	const header = request.headers.get("Authorization");
	if (!header) return null;
	const match = /^Bearer (.+)$/.exec(header);
	return match ? match[1] : null;
}

/**
 * Constant-time byte comparison. Never use `===`/naive string compare on secret
 * material — a short-circuiting compare leaks timing information proportional to the
 * number of matching leading bytes.
 */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a[i] ^ b[i];
	}
	return diff === 0;
}

/**
 * Gate for operator-only `/admin/*` routes. Requires an `Authorization: Bearer` token
 * that constant-time-matches env.OPERATOR_TOKEN. Fails CLOSED when the token is unset
 * or missing — an unconfigured Worker rejects every admin request rather than exposing
 * account/reference provisioning. Both sides are SHA-256'd to fixed 32-byte digests
 * before comparison so timingSafeEqual never leaks token length. Returns a 401
 * Response to short-circuit the handler, or null when the caller is a verified
 * operator.
 */
export async function assertOperator(request: Request, env: OperatorEnv): Promise<Response | null> {
	const provided = extractBearerToken(request);
	if (!env.OPERATOR_TOKEN || !provided) return operatorUnauthorizedResponse();
	const encoder = new TextEncoder();
	const providedDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(provided)));
	const expectedDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(env.OPERATOR_TOKEN)));
	if (!timingSafeEqual(providedDigest, expectedDigest)) return operatorUnauthorizedResponse();
	return null;
}

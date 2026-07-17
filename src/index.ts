import { askQuestion } from "./qa";
import { getNavigatorView, isTimeScope, isVerbosity, TIME_SCOPE_VALUES, VERBOSITY_VALUES } from "./navigator";
import { buildDemoNavigatorView } from "./demo/demoNavigator";
import { askDemoQuestion } from "./demo/demoQa";
import { buildDemoFlagsView } from "./demo/demoFlags";
import { isClaim, isTrustedReference, runReview } from "./review";
import type { TrustedReference } from "./tools/inconsistencyFlagger";

export interface Env {
	NAV_CACHE: KVNamespace;
	STAGING: string;
	ACCESS_STAGING_IDENTITY: string;
}

// TODO: real Cloudflare Access policy (per-recipient OAuth invites) is deferred —
// design doc §4/§5. This staging Worker has no Access edge in `wrangler dev`; treat
// every request as authenticated as ACCESS_STAGING_IDENTITY, matching the one shared
// test/dev identity the design doc calls for tonight.
function assertStagingAccess(env: Env): void {
	if (env.STAGING !== "1") {
		throw new Error("suxos-net is staging-only; refusing to run without STAGING=1");
	}
}

/**
 * Structured error body shape returned for every 4xx this Worker produces. Never a
 * bare thrown exception surfaced to the caller — always this shape, so a client (or
 * a doctor's/attorney's technical staff inspecting this API) gets a machine-readable
 * reason, not a stack trace.
 */
interface ApiError {
	error: string;
	field?: string;
}

/**
 * Reasonable security-header defaults for a JSON API that will eventually sit behind
 * real Cloudflare Access — doesn't require Access to exist to be worth setting now.
 */
function withSecurityHeaders(response: Response, extraHeaders?: HeadersInit): Response {
	const headers = new Headers(response.headers);
	headers.set("X-Content-Type-Options", "nosniff");
	headers.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
	headers.set("Referrer-Policy", "no-referrer");
	if (extraHeaders) {
		for (const [key, value] of new Headers(extraHeaders).entries()) headers.set(key, value);
	}
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function errorResponse(status: number, body: ApiError, extraHeaders?: HeadersInit): Response {
	return withSecurityHeaders(Response.json(body, { status }), extraHeaders);
}

function methodNotAllowed(allow: string): Response {
	return errorResponse(405, { error: `method not allowed, expected ${allow}` }, { Allow: allow });
}

// KV read-through cache for navigator responses (wrangler.jsonc NAV_CACHE). Data is static
// stub content today, so a short TTL is just about cutting recompute, not correctness —
// there's no invalidation to get wrong.
const NAV_CACHE_TTL_SECONDS = 300;

function navCacheKey(verbosity: string, timeScope: string): string {
	return `navigator:v1:${verbosity}:${timeScope}`;
}

async function handleNavigator(request: Request, env: Env): Promise<Response> {
	if (request.method !== "GET") return methodNotAllowed("GET");

	const url = new URL(request.url);
	const verbosityRaw = url.searchParams.get("verbosity") ?? "oneline";
	const timeScopeRaw = url.searchParams.get("timeScope") ?? "week";

	if (!isVerbosity(verbosityRaw)) {
		return errorResponse(400, {
			error: `invalid verbosity; expected one of ${VERBOSITY_VALUES.join(", ")}`,
			field: "verbosity",
		});
	}
	if (!isTimeScope(timeScopeRaw)) {
		return errorResponse(400, {
			error: `invalid timeScope; expected one of ${TIME_SCOPE_VALUES.join(", ")}`,
			field: "timeScope",
		});
	}

	const cacheKey = navCacheKey(verbosityRaw, timeScopeRaw);
	const cached = await env.NAV_CACHE.get(cacheKey);
	if (cached !== null) {
		const entries = JSON.parse(cached) as ReturnType<typeof getNavigatorView>["entries"];
		return withSecurityHeaders(
			Response.json({ verbosity: verbosityRaw, timeScope: timeScopeRaw, entries, generatedAt: new Date().toISOString() }),
		);
	}

	const view = getNavigatorView(verbosityRaw, timeScopeRaw);
	await env.NAV_CACHE.put(cacheKey, JSON.stringify(view.entries), { expirationTtl: NAV_CACHE_TTL_SECONDS });
	return withSecurityHeaders(Response.json(view));
}

/**
 * Shared body-parsing for the two `{ "question": "..." }` POST routes (/api/qa and
 * /demo/qa) — returns either the validated question string or the 400 to send back.
 */
async function extractQuestion(request: Request): Promise<{ question: string } | { error: Response }> {
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

	const question = (parsed as Record<string, unknown>).question;
	if (typeof question !== "string") {
		return { error: errorResponse(400, { error: "missing or non-string question", field: "question" }) };
	}
	if (question.trim().length === 0) {
		return { error: errorResponse(400, { error: "question must not be empty", field: "question" }) };
	}

	return { question };
}

async function handleQa(request: Request): Promise<Response> {
	if (request.method !== "POST") return methodNotAllowed("POST");
	const result = await extractQuestion(request);
	if ("error" in result) return result.error;
	return withSecurityHeaders(Response.json(askQuestion(result.question)));
}

// review's inconsistency/reference-flagging tools are O(claims^2) and O(claims x
// references) respectively (see src/tools/inconsistencyFlagger.ts) and this route has
// no auth in front of it yet (see assertStagingAccess above) — cap array sizes so a
// caller can't force a runaway comparison just by posting a large payload.
const MAX_CLAIMS = 200;
const MAX_REFERENCES = 200;

async function handleReview(request: Request): Promise<Response> {
	if (request.method !== "POST") return methodNotAllowed("POST");

	const contentType = request.headers.get("content-type") ?? "";
	if (!contentType.includes("application/json")) {
		return errorResponse(400, { error: "expected Content-Type: application/json", field: "content-type" });
	}

	let parsed: unknown;
	try {
		parsed = await request.json();
	} catch {
		return errorResponse(400, { error: "request body must be valid JSON" });
	}

	if (typeof parsed !== "object" || parsed === null) {
		return errorResponse(400, { error: "request body must be a JSON object" });
	}
	const body = parsed as Record<string, unknown>;

	const claims = body.claims;
	if (!Array.isArray(claims) || claims.length === 0) {
		return errorResponse(400, { error: "claims must be a non-empty array", field: "claims" });
	}
	if (claims.length > MAX_CLAIMS) {
		return errorResponse(400, { error: `claims must not exceed ${MAX_CLAIMS} entries`, field: "claims" });
	}
	if (!claims.every(isClaim)) {
		return errorResponse(400, {
			error: "every claim must have a non-empty string id, a string text, and an array of string citations",
			field: "claims",
		});
	}

	let references: TrustedReference[] | undefined;
	if (body.references !== undefined) {
		if (!Array.isArray(body.references) || !body.references.every(isTrustedReference)) {
			return errorResponse(400, {
				error: "references must be an array of { id, text, source, sourceUrl? }",
				field: "references",
			});
		}
		if (body.references.length > MAX_REFERENCES) {
			return errorResponse(400, {
				error: `references must not exceed ${MAX_REFERENCES} entries`,
				field: "references",
			});
		}
		references = body.references;
	}

	let knownCitationIds: string[] | undefined;
	if (body.knownCitationIds !== undefined) {
		if (!Array.isArray(body.knownCitationIds) || !body.knownCitationIds.every((c) => typeof c === "string")) {
			return errorResponse(400, {
				error: "knownCitationIds must be an array of strings",
				field: "knownCitationIds",
			});
		}
		knownCitationIds = body.knownCitationIds;
	}

	return withSecurityHeaders(Response.json(runReview({ claims, references, knownCitationIds })));
}

async function handleHealthz(request: Request, env: Env): Promise<Response> {
	if (request.method !== "GET") return methodNotAllowed("GET");
	return withSecurityHeaders(Response.json({ ok: true, staging: true, identity: env.ACCESS_STAGING_IDENTITY }));
}

// --- /demo/* routes: obviously-fictional demo dataset (see src/demo/demoData.ts),
// exercising the real navigator/inconsistencyFlagger/citationIntegrity pipeline.
// Additive only — the bare /api/* routes above are unchanged.

async function handleDemoNavigator(request: Request): Promise<Response> {
	if (request.method !== "GET") return methodNotAllowed("GET");

	const url = new URL(request.url);
	const verbosityRaw = url.searchParams.get("verbosity") ?? "oneline";
	const timeScopeRaw = url.searchParams.get("timeScope") ?? "all";

	if (!isVerbosity(verbosityRaw)) {
		return errorResponse(400, {
			error: `invalid verbosity; expected one of ${VERBOSITY_VALUES.join(", ")}`,
			field: "verbosity",
		});
	}
	if (!isTimeScope(timeScopeRaw)) {
		return errorResponse(400, {
			error: `invalid timeScope; expected one of ${TIME_SCOPE_VALUES.join(", ")}`,
			field: "timeScope",
		});
	}

	return withSecurityHeaders(Response.json(buildDemoNavigatorView(verbosityRaw, timeScopeRaw)));
}

async function handleDemoQa(request: Request): Promise<Response> {
	if (request.method !== "POST") return methodNotAllowed("POST");
	const result = await extractQuestion(request);
	if ("error" in result) return result.error;
	return withSecurityHeaders(Response.json(askDemoQuestion(result.question)));
}

async function handleDemoFlags(request: Request): Promise<Response> {
	if (request.method !== "GET") return methodNotAllowed("GET");
	return withSecurityHeaders(Response.json(buildDemoFlagsView()));
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		assertStagingAccess(env);
		const url = new URL(request.url);

		if (url.pathname === "/api/navigator") return handleNavigator(request, env);
		if (url.pathname === "/api/qa") return handleQa(request);
		if (url.pathname === "/api/review") return handleReview(request);
		if (url.pathname === "/healthz") return handleHealthz(request, env);
		if (url.pathname === "/demo/navigator") return handleDemoNavigator(request);
		if (url.pathname === "/demo/qa") return handleDemoQa(request);
		if (url.pathname === "/demo/flags") return handleDemoFlags(request);

		return withSecurityHeaders(new Response("not found", { status: 404 }));
	},
} satisfies ExportedHandler<Env>;

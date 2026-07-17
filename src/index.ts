import { askQuestion } from "./qa";
import { getNavigatorView, isTimeScope, isVerbosity, TIME_SCOPE_VALUES, VERBOSITY_VALUES } from "./navigator";
import { buildDemoNavigatorView } from "./demo/demoNavigator";
import { askDemoQuestion } from "./demo/demoQa";
import { buildDemoFlagsView } from "./demo/demoFlags";
import { DEMO_CSS, DEMO_HTML, DEMO_JS } from "./frontend/demoFrontend";

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

/**
 * Security headers for the /demo/* frontend assets (HTML/CSS/JS). The JSON API's
 * `default-src 'none'` CSP would block the page from loading its own same-origin
 * script/style/fetch, so this is a separate, still-strict policy: same-origin only,
 * no 'unsafe-inline' anywhere, no framing.
 */
function withFrontendSecurityHeaders(response: Response, contentType: string): Response {
	const headers = new Headers(response.headers);
	headers.set("X-Content-Type-Options", "nosniff");
	headers.set(
		"Content-Security-Policy",
		"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'",
	);
	headers.set("Referrer-Policy", "no-referrer");
	headers.set("Content-Type", contentType);
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function methodNotAllowed(allow: string): Response {
	return errorResponse(405, { error: `method not allowed, expected ${allow}` }, { Allow: allow });
}

// Basic per-client rate limiting (issue #28 audit finding: "none exists currently").
// Best-effort fixed-window counter in NAV_CACHE — KV has no atomic increment, so under
// real concurrency this can undercount, but for a staging Worker with no real traffic
// yet this is a cheap deterrent against the obvious abuse case, not a hard guarantee.
const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_MAX_REQUESTS = 60;

function clientIdentity(request: Request): string {
	return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

async function checkRateLimit(env: Env, identity: string): Promise<boolean> {
	const windowBucket = Math.floor(Date.now() / (RATE_LIMIT_WINDOW_SECONDS * 1000));
	const key = `ratelimit:v1:${identity}:${windowBucket}`;
	const current = Number(await env.NAV_CACHE.get(key)) || 0;
	if (current >= RATE_LIMIT_MAX_REQUESTS) return false;
	await env.NAV_CACHE.put(key, String(current + 1), { expirationTtl: RATE_LIMIT_WINDOW_SECONDS });
	return true;
}

function rateLimitedResponse(): Response {
	return errorResponse(429, { error: "rate limit exceeded, try again shortly" }, { "Retry-After": String(RATE_LIMIT_WINDOW_SECONDS) });
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
		return withSecurityHeaders(new Response(cached, { headers: { "Content-Type": "application/json" } }));
	}

	const body = JSON.stringify(getNavigatorView(verbosityRaw, timeScopeRaw));
	await env.NAV_CACHE.put(cacheKey, body, { expirationTtl: NAV_CACHE_TTL_SECONDS });
	return withSecurityHeaders(new Response(body, { headers: { "Content-Type": "application/json" } }));
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

// --- /demo frontend: the actual rendered 2D navigator UI (verbosity × time-scope,
// QA pointer-routing, hedged flags) on top of the /demo/navigator, /demo/qa, /demo/flags
// JSON above — see src/frontend/demoFrontend.ts. Static assets, no server-side state.

function handleDemoPage(request: Request): Response {
	if (request.method !== "GET") return methodNotAllowed("GET");
	return withFrontendSecurityHeaders(new Response(DEMO_HTML), "text/html; charset=utf-8");
}

function handleDemoAppCss(request: Request): Response {
	if (request.method !== "GET") return methodNotAllowed("GET");
	return withFrontendSecurityHeaders(new Response(DEMO_CSS), "text/css; charset=utf-8");
}

function handleDemoAppJs(request: Request): Response {
	if (request.method !== "GET") return methodNotAllowed("GET");
	return withFrontendSecurityHeaders(new Response(DEMO_JS), "text/javascript; charset=utf-8");
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		assertStagingAccess(env);
		const url = new URL(request.url);

		if (url.pathname.startsWith("/api/") && !(await checkRateLimit(env, clientIdentity(request)))) {
			return rateLimitedResponse();
		}

		if (url.pathname === "/api/navigator") return handleNavigator(request, env);
		if (url.pathname === "/api/qa") return handleQa(request);
		if (url.pathname === "/healthz") return handleHealthz(request, env);
		if (url.pathname === "/demo/navigator") return handleDemoNavigator(request);
		if (url.pathname === "/demo/qa") return handleDemoQa(request);
		if (url.pathname === "/demo/flags") return handleDemoFlags(request);
		if (url.pathname === "/demo" || url.pathname === "/demo/") return handleDemoPage(request);
		if (url.pathname === "/demo/app.css") return handleDemoAppCss(request);
		if (url.pathname === "/demo/app.js") return handleDemoAppJs(request);

		return withSecurityHeaders(new Response("not found", { status: 404 }));
	},
} satisfies ExportedHandler<Env>;

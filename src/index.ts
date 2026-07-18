import { askQuestion } from "./qa";
import { handleReview } from "./review";
import { getNavigatorView, isTimeScope, isVerbosity, TIME_SCOPE_VALUES, VERBOSITY_VALUES, type NavigatorResponse } from "./navigator";
import { buildDemoNavigatorView } from "./demo/demoNavigator";
import { askDemoQuestion, type QaFormat } from "./demo/demoQa";
import { buildDemoFlagsView } from "./demo/demoFlags";
import { buildDemoHighlightsView } from "./demo/demoHighlights";
import { DEMO_CSS, DEMO_HTML, DEMO_JS } from "./frontend/demoFrontend";
import {
	handleAdminCreateAccount,
	handleAdminResetPassword,
	handleLogin,
	handleLogout,
	requireSession,
	unauthorizedResponse,
} from "./auth/routes";
import { isIpRequestAllowed } from "./auth/rateLimiter";

// The atomic rate-limit / lockout Durable Object must be re-exported from the Worker
// entrypoint so wrangler can bind it (durable_objects.bindings in wrangler.jsonc).
export { RateLimiterDO } from "./auth/rateLimiter";

export interface Env {
	NAV_CACHE: KVNamespace;
	// Atomic per-IP and per-username counters (#35). KV has no atomic increment, so
	// both rate limiters live in this serialised Durable Object namespace — see
	// src/auth/rateLimiter.ts. Closes the two TOCTOU HIGHs on #35.
	RATE_LIMITER: DurableObjectNamespace;
	STAGING: string;
	ACCESS_STAGING_IDENTITY: string;
	// HMAC signing secret for recipient session cookies (#18). Set via
	// `wrangler secret put SESSION_SECRET` — never a `vars` entry, never committed.
	SESSION_SECRET: string;
	// Bearer secret for operator-only /admin/* routes (#18). Set via
	// `wrangler secret put OPERATOR_TOKEN`. Fails closed when unset (admin → 401).
	OPERATOR_TOKEN: string;
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

// Per-client rate limiting (issue #28 audit finding: "none exists currently").
// Fixed-window counter in the RateLimiterDO Durable Object — NOT KV. KV has no atomic
// increment, so the old get-then-put here was a TOCTOU race: a burst of concurrent
// requests could all read the same pre-increment count and pass together, blowing past
// the budget (security-review HIGH on #35). The DO serialises increment-and-check per
// IP, so the 60/60s budget is now a hard guarantee, not a best-effort deterrent.
const RATE_LIMIT_WINDOW_SECONDS = 60;
const RATE_LIMIT_MAX_REQUESTS = 60;

function clientIdentity(request: Request): string {
	return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

// Paths that pass through the per-IP rate limiter before dispatch. Covers the JSON
// API (/api/*) plus the auth surface: /login (per-IP throttle on top of the
// per-username lockout in auth/store.ts — the lockout alone can't stop password
// spraying, where each username only ever accrues one failed attempt) and every
// operator /admin/* route (account provisioning + reset). The operator bearer-token
// gate still applies inside those handlers; this is an additive layer in front of it.
function isRateLimitedPath(pathname: string): boolean {
	return pathname.startsWith("/api/") || pathname === "/login" || pathname.startsWith("/admin/");
}

async function checkRateLimit(env: Env, identity: string): Promise<boolean> {
	return isIpRequestAllowed(env.RATE_LIMITER, identity, RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_SECONDS * 1000);
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

	const username = await requireSession(request, env);
	if (!username) return withSecurityHeaders(unauthorizedResponse());

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
		// Only `entries` is what's worth caching — `generatedAt` must reflect this
		// response's actual time, not whenever the cache entry was first computed (#7),
		// or a caller relying on it for freshness would be misled once entries stop
		// being static stubs.
		const view: NavigatorResponse = { ...(JSON.parse(cached) as NavigatorResponse), generatedAt: new Date().toISOString() };
		return withSecurityHeaders(Response.json(view));
	}

	const view = getNavigatorView(verbosityRaw, timeScopeRaw);
	await env.NAV_CACHE.put(cacheKey, JSON.stringify(view), { expirationTtl: NAV_CACHE_TTL_SECONDS });
	return withSecurityHeaders(Response.json(view));
}

const QA_FORMAT_VALUES: readonly QaFormat[] = ["default", "haiku"];

function isQaFormat(value: unknown): value is QaFormat {
	return typeof value === "string" && (QA_FORMAT_VALUES as readonly string[]).includes(value);
}

/**
 * Shared body-parsing for the two `{ "question": "..." }` POST routes (/api/qa and
 * /demo/qa) — returns either the validated question (and optional "haiku mode"
 * format, design doc §3) or the 400 to send back.
 */
async function extractQuestion(request: Request): Promise<{ question: string; format: QaFormat } | { error: Response }> {
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

	const formatRaw = (parsed as Record<string, unknown>).format;
	if (formatRaw !== undefined && !isQaFormat(formatRaw)) {
		return {
			error: errorResponse(400, { error: `invalid format; expected one of ${QA_FORMAT_VALUES.join(", ")}`, field: "format" }),
		};
	}

	return { question, format: formatRaw ?? "default" };
}

async function handleQa(request: Request, env: Env): Promise<Response> {
	if (request.method !== "POST") return methodNotAllowed("POST");
	const username = await requireSession(request, env);
	if (!username) return withSecurityHeaders(unauthorizedResponse());
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
	return withSecurityHeaders(Response.json(askDemoQuestion(result.question, result.format)));
}

async function handleDemoFlags(request: Request): Promise<Response> {
	if (request.method !== "GET") return methodNotAllowed("GET");
	return withSecurityHeaders(Response.json(buildDemoFlagsView()));
}

async function handleDemoHighlights(request: Request): Promise<Response> {
	if (request.method !== "GET") return methodNotAllowed("GET");
	return withSecurityHeaders(Response.json(buildDemoHighlightsView()));
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

		if (isRateLimitedPath(url.pathname) && !(await checkRateLimit(env, clientIdentity(request)))) {
			return rateLimitedResponse();
		}

		if (url.pathname === "/api/navigator") return handleNavigator(request, env);
		if (url.pathname === "/api/qa") return handleQa(request, env);
		if (url.pathname === "/api/review") return withSecurityHeaders(await handleReview(request, env));
		if (url.pathname === "/healthz") return handleHealthz(request, env);
		if (url.pathname === "/demo/navigator") return handleDemoNavigator(request);
		if (url.pathname === "/demo/qa") return handleDemoQa(request);
		if (url.pathname === "/demo/flags") return handleDemoFlags(request);
		if (url.pathname === "/demo/highlights") return handleDemoHighlights(request);
		if (url.pathname === "/demo" || url.pathname === "/demo/") return handleDemoPage(request);
		if (url.pathname === "/demo/app.css") return handleDemoAppCss(request);
		if (url.pathname === "/demo/app.js") return handleDemoAppJs(request);

		// --- Recipient auth (#18) ---
		if (url.pathname === "/login") return withSecurityHeaders(await handleLogin(request, env));
		if (url.pathname === "/logout") return withSecurityHeaders(await handleLogout(request));

		// --- Operator-only admin routes: account provisioning + reset. No self-serve
		// signup exists anywhere in this Worker — these are the only ways an account
		// is created or a password changed. Each handler independently enforces an
		// operator bearer token (OPERATOR_TOKEN) and fails closed if it is unset, so
		// these routes are NOT exposed on a bare `*.workers.dev` deploy even though
		// no Cloudflare Access edge fronts this staging Worker yet.
		if (url.pathname === "/admin/accounts") return withSecurityHeaders(await handleAdminCreateAccount(request, env));
		if (url.pathname === "/admin/accounts/reset") return withSecurityHeaders(await handleAdminResetPassword(request, env));

		return withSecurityHeaders(new Response("not found", { status: 404 }));
	},
} satisfies ExportedHandler<Env>;

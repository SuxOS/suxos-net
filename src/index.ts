import { askQuestion } from "./qa";
import { getNavigatorView, isTimeScope, isVerbosity, TIME_SCOPE_VALUES, VERBOSITY_VALUES } from "./navigator";

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

async function handleNavigator(request: Request): Promise<Response> {
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

	return withSecurityHeaders(Response.json(getNavigatorView(verbosityRaw, timeScopeRaw)));
}

async function handleQa(request: Request): Promise<Response> {
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

	const question = (parsed as Record<string, unknown>).question;
	if (typeof question !== "string") {
		return errorResponse(400, { error: "missing or non-string question", field: "question" });
	}
	if (question.trim().length === 0) {
		return errorResponse(400, { error: "question must not be empty", field: "question" });
	}

	return withSecurityHeaders(Response.json(askQuestion(question)));
}

async function handleHealthz(request: Request, env: Env): Promise<Response> {
	if (request.method !== "GET") return methodNotAllowed("GET");
	return withSecurityHeaders(Response.json({ ok: true, staging: true, identity: env.ACCESS_STAGING_IDENTITY }));
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		assertStagingAccess(env);
		const url = new URL(request.url);

		if (url.pathname === "/api/navigator") return handleNavigator(request);
		if (url.pathname === "/api/qa") return handleQa(request);
		if (url.pathname === "/healthz") return handleHealthz(request, env);

		return withSecurityHeaders(new Response("not found", { status: 404 }));
	},
} satisfies ExportedHandler<Env>;

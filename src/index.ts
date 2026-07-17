import { askQuestion } from "./qa";
import { getNavigatorView, isTimeScope, isVerbosity, TIME_SCOPE_VALUES, VERBOSITY_VALUES } from "./navigator";
import { buildDemoNavigatorView } from "./demo/demoNavigator";
import { askDemoQuestion } from "./demo/demoQa";
import { buildDemoFlagsView } from "./demo/demoFlags";
import { buildDemoAccessWhoamiView } from "./demo/demoAccess";
import { buildDemoReferencesView } from "./demo/demoReferences";
import { createAuditLog } from "./audit/auditLog";

export interface Env {
	NAV_CACHE: KVNamespace;
	STAGING: string;
	ACCESS_STAGING_IDENTITY: string;
	// Feature flag for the per-recipient invite + access-scoping layer (src/access/
	// accessScopes.ts). Off unless explicitly "1" — the mechanism is additive and must
	// never change behavior of the existing single-identity Access gate above when
	// unset. No real recipients/scopes exist yet regardless of this flag's value.
	ACCESS_SCOPING_ENABLED?: string;
}

function isAccessScopingEnabled(env: Env): boolean {
	return env.ACCESS_SCOPING_ENABLED === "1";
}

// Append-only accountability trail (identity, timestamp, route, metadata-only detail —
// never record content). One log shared by /api/* and /demo/* routes, distinguished by
// each entry's `route` field. In-memory per-isolate, same pattern as the rest of this
// file's stub/demo stores — see src/audit/auditLog.ts.
const auditLog = createAuditLog();

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

	const view = getNavigatorView(verbosityRaw, timeScopeRaw);
	auditLog.append({
		identity: env.ACCESS_STAGING_IDENTITY,
		timestamp: new Date().toISOString(),
		route: "/api/navigator",
		detail: {
			kind: "navigator",
			timeScope: timeScopeRaw,
			verbosity: verbosityRaw,
			entryIds: view.entries.map((entry) => entry.id),
		},
	});
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

async function handleQa(request: Request, env: Env): Promise<Response> {
	if (request.method !== "POST") return methodNotAllowed("POST");
	const result = await extractQuestion(request);
	if ("error" in result) return result.error;
	const response = askQuestion(result.question);
	auditLog.append({
		identity: env.ACCESS_STAGING_IDENTITY,
		timestamp: new Date().toISOString(),
		route: "/api/qa",
		detail: { kind: "qa", query: result.question, citedIds: response.citations, status: response.status },
	});
	return withSecurityHeaders(Response.json(response));
}

async function handleHealthz(request: Request, env: Env): Promise<Response> {
	if (request.method !== "GET") return methodNotAllowed("GET");
	return withSecurityHeaders(Response.json({ ok: true, staging: true, identity: env.ACCESS_STAGING_IDENTITY }));
}

// --- /demo/* routes: obviously-fictional demo dataset (see src/demo/demoData.ts),
// exercising the real navigator/inconsistencyFlagger/citationIntegrity pipeline.
// Additive only — the bare /api/* routes above are unchanged.

async function handleDemoNavigator(request: Request, env: Env): Promise<Response> {
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

	const view = buildDemoNavigatorView(verbosityRaw, timeScopeRaw);
	auditLog.append({
		identity: env.ACCESS_STAGING_IDENTITY,
		timestamp: new Date().toISOString(),
		route: "/demo/navigator",
		detail: {
			kind: "navigator",
			timeScope: timeScopeRaw,
			verbosity: verbosityRaw,
			entryIds: view.entries.map((entry) => entry.id),
		},
	});
	return withSecurityHeaders(Response.json(view));
}

async function handleDemoQa(request: Request, env: Env): Promise<Response> {
	if (request.method !== "POST") return methodNotAllowed("POST");
	const result = await extractQuestion(request);
	if ("error" in result) return result.error;
	const response = askDemoQuestion(result.question);
	auditLog.append({
		identity: env.ACCESS_STAGING_IDENTITY,
		timestamp: new Date().toISOString(),
		route: "/demo/qa",
		detail: {
			kind: "qa",
			query: result.question,
			citedIds: response.matches.map((match) => match.id),
			status: response.status,
		},
	});
	return withSecurityHeaders(Response.json(response));
}

async function handleDemoFlags(request: Request): Promise<Response> {
	if (request.method !== "GET") return methodNotAllowed("GET");
	return withSecurityHeaders(Response.json(buildDemoFlagsView()));
}

// Read-only demo view of the curated trusted-reference store (src/tools/
// trustedReferenceStore.ts) — no write CRUD is exposed over HTTP; admin add/edit/
// remove is a server-side/module-level operation only (see that module's tests).
async function handleDemoReferences(request: Request): Promise<Response> {
	if (request.method !== "GET") return methodNotAllowed("GET");
	return withSecurityHeaders(Response.json(buildDemoReferencesView()));
}

// Read-only demo view of the per-recipient access-scoping mechanism (src/access/
// accessScopes.ts). Gated behind ACCESS_SCOPING_ENABLED — 404s (as if the route didn't
// exist) when the flag is unset, so this stays inert by default.
async function handleDemoAccessWhoami(request: Request, env: Env): Promise<Response> {
	if (!isAccessScopingEnabled(env)) return withSecurityHeaders(new Response("not found", { status: 404 }));
	if (request.method !== "GET") return methodNotAllowed("GET");

	const url = new URL(request.url);
	const identity = url.searchParams.get("identity");
	if (!identity) {
		return errorResponse(400, { error: "missing required identity query param", field: "identity" });
	}

	return withSecurityHeaders(Response.json(buildDemoAccessWhoamiView(identity)));
}

// Read-only admin view of the append-only access audit log (src/audit/auditLog.ts).
// Sits behind the same worker-level assertStagingAccess gate as every other route —
// this does not introduce a separate, weaker auth path.
async function handleAdminAuditLog(request: Request): Promise<Response> {
	if (request.method !== "GET") return methodNotAllowed("GET");
	return withSecurityHeaders(Response.json({ entries: auditLog.list() }));
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		assertStagingAccess(env);
		const url = new URL(request.url);

		if (url.pathname === "/api/navigator") return handleNavigator(request, env);
		if (url.pathname === "/api/qa") return handleQa(request, env);
		if (url.pathname === "/healthz") return handleHealthz(request, env);
		if (url.pathname === "/admin/audit-log") return handleAdminAuditLog(request);
		if (url.pathname === "/demo/navigator") return handleDemoNavigator(request, env);
		if (url.pathname === "/demo/qa") return handleDemoQa(request, env);
		if (url.pathname === "/demo/references") return handleDemoReferences(request);
		if (url.pathname === "/demo/access/whoami") return handleDemoAccessWhoami(request, env);
		if (url.pathname === "/demo/flags") return handleDemoFlags(request);

		return withSecurityHeaders(new Response("not found", { status: 404 }));
	},
} satisfies ExportedHandler<Env>;

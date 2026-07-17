import { askQuestion } from "./qa";
import { getNavigatorView, isTimeScope, isVerbosity, TIME_SCOPE_VALUES, VERBOSITY_VALUES } from "./navigator";
import { buildDemoNavigatorView } from "./demo/demoNavigator";
import { askDemoQuestion } from "./demo/demoQa";
import { buildDemoFlagsView } from "./demo/demoFlags";
import {
	handleAdminCreateAccount,
	handleAdminResetPassword,
	handleLogin,
	handleLogout,
	requireSession,
	unauthorizedResponse,
} from "./auth/routes";
import { syncVaultEmbeddings } from "./embeddings/sync";

export interface Env {
	NAV_CACHE: KVNamespace;
	STAGING: string;
	ACCESS_STAGING_IDENTITY: string;
	// HMAC signing secret for recipient session cookies (#18). Set via
	// `wrangler secret put SESSION_SECRET` — never a `vars` entry, never committed.
	SESSION_SECRET: string;
	// Workers AI binding — embeds QA questions and suxvault chunks with the same
	// model (bge-base-en-v1.5), and generates citation-constrained QA answers.
	AI: Ai;
	// Vectorize index `suxvault-notes` (768-dim, cosine) — populated by
	// POST /admin/sync-embeddings, queried by POST /api/qa.
	VECTORIZE_INDEX: Vectorize;
	// GitHub PAT (repo:read on SuxOS/suxvault) used only by the sync route to fetch
	// current note content. Set via `wrangler secret put GITHUB_TOKEN`.
	GITHUB_TOKEN: string;
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

	return withSecurityHeaders(Response.json(getNavigatorView(verbosityRaw, timeScopeRaw)));
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
	const username = await requireSession(request, env);
	if (!username) return withSecurityHeaders(unauthorizedResponse());
	const result = await extractQuestion(request);
	if ("error" in result) return result.error;
	const response = await askQuestion(result.question, { AI: env.AI, VECTORIZE_INDEX: env.VECTORIZE_INDEX });
	return withSecurityHeaders(Response.json(response));
}

/**
 * POST /admin/sync-embeddings — operator-only (issue #30), re-chunks and re-embeds
 * every markdown note in suxvault and upserts the result into the suxvault-notes
 * Vectorize index. Idempotent — safe to re-run any time suxvault content changes.
 * Reachable only inside the Worker-wide assertStagingAccess gate, same convention
 * as the other /admin/* routes in src/auth/routes.ts.
 */
async function handleSyncEmbeddings(request: Request, env: Env): Promise<Response> {
	if (request.method !== "POST") return methodNotAllowed("POST");
	try {
		const result = await syncVaultEmbeddings(env.AI, env.VECTORIZE_INDEX, env.GITHUB_TOKEN);
		return withSecurityHeaders(Response.json(result));
	} catch (err) {
		return errorResponse(502, { error: `embedding sync failed: ${err instanceof Error ? err.message : String(err)}` });
	}
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
		if (url.pathname === "/api/qa") return handleQa(request, env);
		if (url.pathname === "/healthz") return handleHealthz(request, env);
		if (url.pathname === "/demo/navigator") return handleDemoNavigator(request);
		if (url.pathname === "/demo/qa") return handleDemoQa(request);
		if (url.pathname === "/demo/flags") return handleDemoFlags(request);

		// --- Recipient auth (#18) ---
		if (url.pathname === "/login") return withSecurityHeaders(await handleLogin(request, env));
		if (url.pathname === "/logout") return withSecurityHeaders(await handleLogout(request));

		// --- Operator-only admin routes: account provisioning + reset. No self-serve
		// signup exists anywhere in this Worker — these are the only ways an account
		// is created or a password changed, and both are reachable only inside this
		// staging Worker's assertStagingAccess gate above (a real deployment fronts
		// this with the operator's own Cloudflare Access policy, unchanged).
		if (url.pathname === "/admin/accounts") return withSecurityHeaders(await handleAdminCreateAccount(request, env));
		if (url.pathname === "/admin/accounts/reset") return withSecurityHeaders(await handleAdminResetPassword(request, env));
		if (url.pathname === "/admin/sync-embeddings") return handleSyncEmbeddings(request, env);

		return withSecurityHeaders(new Response("not found", { status: 404 }));
	},
} satisfies ExportedHandler<Env>;

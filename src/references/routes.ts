/**
 * HTTP handlers for operator-only trusted-reference curation (#19). Wired into
 * src/index.ts under /admin/references*. Same operator-bearer-token gate as the
 * account admin routes (src/auth/routes.ts) — see assertOperator. Single-curator
 * model for now: any verified operator may add/edit/remove references.
 */

import type { OperatorEnv } from "../auth/operatorAuth";
import { assertOperator } from "../auth/operatorAuth";
import { MAX_JSON_BODY_BYTES, readBodyWithLimit } from "../http/bodyLimit";
import { createReference, deleteReference, listReferences, updateReference, type CreateReferenceInput, type UpdateReferenceInput } from "./store";

export interface ReferencesEnv extends OperatorEnv {
	NAV_CACHE: KVNamespace;
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
	const bodyResult = await readBodyWithLimit(request, MAX_JSON_BODY_BYTES);
	if (!bodyResult.ok) {
		return { error: errorResponse(413, { error: "request body too large" }) };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(bodyResult.text);
	} catch {
		return { error: errorResponse(400, { error: "request body must be valid JSON" }) };
	}
	if (typeof parsed !== "object" || parsed === null) {
		return { error: errorResponse(400, { error: "request body must be a JSON object" }) };
	}
	return { body: parsed as Record<string, unknown> };
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function extractCreateInput(body: Record<string, unknown>): CreateReferenceInput | { error: Response } {
	const { fact, source, sourceUrl, curator, scopeOfApplicability } = body;
	if (typeof fact !== "string" || fact.trim().length === 0) {
		return { error: errorResponse(400, { error: "missing or non-string fact", field: "fact" }) };
	}
	if (typeof source !== "string" || source.trim().length === 0) {
		return { error: errorResponse(400, { error: "missing or non-string source", field: "source" }) };
	}
	if (typeof curator !== "string" || curator.trim().length === 0) {
		return { error: errorResponse(400, { error: "missing or non-string curator", field: "curator" }) };
	}
	if (typeof scopeOfApplicability !== "string" || scopeOfApplicability.trim().length === 0) {
		return { error: errorResponse(400, { error: "missing or non-string scopeOfApplicability", field: "scopeOfApplicability" }) };
	}
	if (sourceUrl !== undefined && typeof sourceUrl !== "string") {
		return { error: errorResponse(400, { error: "sourceUrl must be a string when present", field: "sourceUrl" }) };
	}
	return { fact, source, sourceUrl, curator, scopeOfApplicability };
}

/**
 * GET /admin/references — list every curated reference.
 * POST /admin/references — add one explicitly human-curated reference.
 * Both operator-only.
 */
export async function handleAdminReferences(request: Request, env: ReferencesEnv): Promise<Response> {
	const denied = await assertOperator(request, env);
	if (denied) return denied;

	if (request.method === "GET") {
		const references = await listReferences(env.NAV_CACHE);
		return jsonResponse(200, { references });
	}

	if (request.method === "POST") {
		const parsedBody = await parseJsonBody(request);
		if ("error" in parsedBody) return parsedBody.error;
		const parsed = extractCreateInput(parsedBody.body);
		if ("error" in parsed) return parsed.error;

		const result = await createReference(env.NAV_CACHE, parsed);
		if (!result.ok) return errorResponse(400, { error: result.error });
		return jsonResponse(201, { ok: true, reference: result.reference });
	}

	return errorResponse(405, { error: "method not allowed, expected GET or POST" }, { Allow: "GET, POST" });
}

function extractUpdateInput(body: Record<string, unknown>): { id: string; patch: UpdateReferenceInput } | { error: Response } {
	const { id } = body;
	if (typeof id !== "string" || id.trim().length === 0) {
		return { error: errorResponse(400, { error: "missing or non-string id", field: "id" }) };
	}
	for (const field of ["fact", "source", "sourceUrl", "curator", "scopeOfApplicability"] as const) {
		if (body[field] !== undefined && typeof body[field] !== "string") {
			return { error: errorResponse(400, { error: `${field} must be a string when present`, field }) };
		}
	}
	return {
		id,
		patch: {
			fact: optionalString(body.fact),
			source: optionalString(body.source),
			sourceUrl: optionalString(body.sourceUrl),
			curator: optionalString(body.curator),
			scopeOfApplicability: optionalString(body.scopeOfApplicability),
		},
	};
}

/** POST /admin/references/update — operator-only, edits an existing reference by id. */
export async function handleAdminUpdateReference(request: Request, env: ReferencesEnv): Promise<Response> {
	if (request.method !== "POST") return errorResponse(405, { error: "method not allowed, expected POST" }, { Allow: "POST" });

	const denied = await assertOperator(request, env);
	if (denied) return denied;

	const parsedBody = await parseJsonBody(request);
	if ("error" in parsedBody) return parsedBody.error;
	const parsed = extractUpdateInput(parsedBody.body);
	if ("error" in parsed) return parsed.error;

	const result = await updateReference(env.NAV_CACHE, parsed.id, parsed.patch);
	if (!result.ok) return errorResponse(404, { error: result.error });
	return jsonResponse(200, { ok: true, reference: result.reference });
}

/** POST /admin/references/delete — operator-only, removes a reference by id. */
export async function handleAdminDeleteReference(request: Request, env: ReferencesEnv): Promise<Response> {
	if (request.method !== "POST") return errorResponse(405, { error: "method not allowed, expected POST" }, { Allow: "POST" });

	const denied = await assertOperator(request, env);
	if (denied) return denied;

	const parsedBody = await parseJsonBody(request);
	if ("error" in parsedBody) return parsedBody.error;
	const { id } = parsedBody.body;
	if (typeof id !== "string" || id.trim().length === 0) {
		return errorResponse(400, { error: "missing or non-string id", field: "id" });
	}

	const result = await deleteReference(env.NAV_CACHE, id);
	if (!result.ok) return errorResponse(404, { error: result.error });
	return jsonResponse(200, { ok: true });
}

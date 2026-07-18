/**
 * Operator-only admin CRUD over the curated trusted-reference store (#19). Same
 * operator-bearer-token gate as every other /admin/* route (src/auth/routes.ts's
 * assertOperator) — no separate credential to provision. This is the ONLY way a
 * trusted reference is ever created, edited, or removed; see src/references/store.ts's
 * header and the runtime guard in src/review.ts.
 */

import { assertOperator, type AuthEnv } from "../auth/routes";
import { readJsonBodyWithLimit } from "../httpBody";
import {
	createReference,
	deleteReference,
	listReferences,
	updateReference,
	type CreateReferenceInput,
	type UpdateReferenceInput,
} from "./store";

export type ReferencesEnv = AuthEnv;

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

function methodNotAllowed(allow: string): Response {
	return errorResponse(405, { error: `method not allowed, expected ${allow}` }, { Allow: allow });
}

// Same order-of-magnitude bounds as /api/review's claim/reference field caps
// (src/review.ts) — this is the data those caps ultimately protect against fanning out
// from, so the same-sized limits apply here at the point of curation.
const MAX_ID_LENGTH = 200;
const MAX_TEXT_LENGTH = 4000;
const MAX_SOURCE_LENGTH = 500;
const MAX_CURATOR_LENGTH = 200;
const MAX_SCOPE_LENGTH = 500;

function isNonEmptyString(value: unknown, maxLength: number): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
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

function extractCreateInput(body: Record<string, unknown>): { input: CreateReferenceInput } | { error: Response } {
	const { id, text, source, sourceUrl, curator, scopeOfApplicability } = body;

	if (!isNonEmptyString(id, MAX_ID_LENGTH)) {
		return { error: errorResponse(400, { error: "missing, empty, or too-long id", field: "id" }) };
	}
	if (!isNonEmptyString(text, MAX_TEXT_LENGTH)) {
		return { error: errorResponse(400, { error: `missing, empty, or over ${MAX_TEXT_LENGTH} characters`, field: "text" }) };
	}
	if (!isNonEmptyString(source, MAX_SOURCE_LENGTH)) {
		return { error: errorResponse(400, { error: `missing, empty, or over ${MAX_SOURCE_LENGTH} characters`, field: "source" }) };
	}
	if (sourceUrl !== undefined && !isNonEmptyString(sourceUrl, MAX_SOURCE_LENGTH)) {
		return {
			error: errorResponse(400, {
				error: `must be a non-empty string of at most ${MAX_SOURCE_LENGTH} characters`,
				field: "sourceUrl",
			}),
		};
	}
	if (!isNonEmptyString(curator, MAX_CURATOR_LENGTH)) {
		return { error: errorResponse(400, { error: `missing, empty, or over ${MAX_CURATOR_LENGTH} characters`, field: "curator" }) };
	}
	if (!isNonEmptyString(scopeOfApplicability, MAX_SCOPE_LENGTH)) {
		return {
			error: errorResponse(400, {
				error: `missing, empty, or over ${MAX_SCOPE_LENGTH} characters`,
				field: "scopeOfApplicability",
			}),
		};
	}

	return { input: { id, text, source, ...(sourceUrl !== undefined ? { sourceUrl } : {}), curator, scopeOfApplicability } };
}

function extractUpdateInput(body: Record<string, unknown>): { id: string; patch: UpdateReferenceInput } | { error: Response } {
	const { id, text, source, sourceUrl, curator, scopeOfApplicability } = body;

	if (!isNonEmptyString(id, MAX_ID_LENGTH)) {
		return { error: errorResponse(400, { error: "missing, empty, or too-long id", field: "id" }) };
	}

	const patch: UpdateReferenceInput = {};
	if (text !== undefined) {
		if (!isNonEmptyString(text, MAX_TEXT_LENGTH)) {
			return { error: errorResponse(400, { error: `must be non-empty and at most ${MAX_TEXT_LENGTH} characters`, field: "text" }) };
		}
		patch.text = text;
	}
	if (source !== undefined) {
		if (!isNonEmptyString(source, MAX_SOURCE_LENGTH)) {
			return {
				error: errorResponse(400, { error: `must be non-empty and at most ${MAX_SOURCE_LENGTH} characters`, field: "source" }),
			};
		}
		patch.source = source;
	}
	if (sourceUrl !== undefined) {
		if (!isNonEmptyString(sourceUrl, MAX_SOURCE_LENGTH)) {
			return {
				error: errorResponse(400, {
					error: `must be non-empty and at most ${MAX_SOURCE_LENGTH} characters`,
					field: "sourceUrl",
				}),
			};
		}
		patch.sourceUrl = sourceUrl;
	}
	if (curator !== undefined) {
		if (!isNonEmptyString(curator, MAX_CURATOR_LENGTH)) {
			return {
				error: errorResponse(400, { error: `must be non-empty and at most ${MAX_CURATOR_LENGTH} characters`, field: "curator" }),
			};
		}
		patch.curator = curator;
	}
	if (scopeOfApplicability !== undefined) {
		if (!isNonEmptyString(scopeOfApplicability, MAX_SCOPE_LENGTH)) {
			return {
				error: errorResponse(400, {
					error: `must be non-empty and at most ${MAX_SCOPE_LENGTH} characters`,
					field: "scopeOfApplicability",
				}),
			};
		}
		patch.scopeOfApplicability = scopeOfApplicability;
	}

	return { id, patch };
}

/** GET /admin/references — operator-only, lists every curated reference. */
export async function handleListReferences(request: Request, env: ReferencesEnv): Promise<Response> {
	if (request.method !== "GET") return methodNotAllowed("GET");

	const denied = await assertOperator(request, env);
	if (denied) return denied;

	const url = new URL(request.url);
	const cursor = url.searchParams.get("cursor") ?? undefined;
	const result = await listReferences(env.NAV_CACHE, undefined, cursor);
	return jsonResponse(200, result);
}

/** POST /admin/references — operator-only, curates one new trusted reference. */
export async function handleCreateReference(request: Request, env: ReferencesEnv): Promise<Response> {
	if (request.method !== "POST") return methodNotAllowed("POST");

	const denied = await assertOperator(request, env);
	if (denied) return denied;

	const parsedBody = await parseJsonBody(request);
	if ("error" in parsedBody) return parsedBody.error;
	const parsed = extractCreateInput(parsedBody.body);
	if ("error" in parsed) return parsed.error;

	const result = await createReference(env.NAV_CACHE, parsed.input);
	if (!result.ok) return errorResponse(409, { error: result.error });
	return jsonResponse(201, result.reference);
}

/** POST /admin/references/update — operator-only edit of an existing reference. */
export async function handleUpdateReference(request: Request, env: ReferencesEnv): Promise<Response> {
	if (request.method !== "POST") return methodNotAllowed("POST");

	const denied = await assertOperator(request, env);
	if (denied) return denied;

	const parsedBody = await parseJsonBody(request);
	if ("error" in parsedBody) return parsedBody.error;
	const parsed = extractUpdateInput(parsedBody.body);
	if ("error" in parsed) return parsed.error;

	const result = await updateReference(env.NAV_CACHE, parsed.id, parsed.patch);
	if (!result.ok) return errorResponse(404, { error: result.error });
	return jsonResponse(200, result.reference);
}

/** POST /admin/references/delete — operator-only removal of a curated reference. */
export async function handleDeleteReference(request: Request, env: ReferencesEnv): Promise<Response> {
	if (request.method !== "POST") return methodNotAllowed("POST");

	const denied = await assertOperator(request, env);
	if (denied) return denied;

	const parsedBody = await parseJsonBody(request);
	if ("error" in parsedBody) return parsedBody.error;
	const { id } = parsedBody.body;
	if (!isNonEmptyString(id, MAX_ID_LENGTH)) {
		return errorResponse(400, { error: "missing, empty, or too-long id", field: "id" });
	}

	const result = await deleteReference(env.NAV_CACHE, id);
	if (!result.ok) return errorResponse(404, { error: result.error });
	return jsonResponse(200, { ok: true });
}

/**
 * Reviewer-facing record-integrity endpoint (#5) — wires the four already-built, pure
 * inconsistencyFlagger/citationIntegrity tools into one HTTP surface: `POST /api/review`.
 * The reviewer (e.g. a doctor or attorney checking the record) submits the claims (and,
 * optionally, a small curated set of trusted references) to check, and gets back every
 * hedged flag/signal/report in one response — same never-fabricate, structured-error,
 * `withSecurityHeaders` discipline as every other route in this Worker.
 *
 * suxvault is still empty, so this endpoint has no server-side record to pull claims
 * from — the caller passes the claims (and optional references) directly in the request
 * body. Once real suxvault-backed retrieval lands, that becomes the source of `claims`
 * instead of the request body, but this input contract (a bounded array of claims plus
 * an optional bounded array of trusted references) stays the same either way.
 */

import {
	findInconsistencies,
	findGroundingSignals,
	flagAgainstReferences,
	type Claim,
	type TrustedReference,
	type InconsistencyFlag,
	type GroundingSignal,
	type ReferenceInconsistencyFlag,
} from "./tools/inconsistencyFlagger";
import { checkCitationIntegrity, type CitationIntegrityReport } from "./tools/citationIntegrity";
import { requireSession, unauthorizedResponse, type AuthEnv } from "./auth/routes";

export interface ReviewResult {
	selfConsistency: InconsistencyFlag[];
	groundingSignals: GroundingSignal[];
	referenceConsistency: ReferenceInconsistencyFlag[];
	citationIntegrity: CitationIntegrityReport;
}

/**
 * Runs every review tool over one bounded batch of claims/references. Computes
 * `findInconsistencies` exactly once and threads it into `findGroundingSignals` as
 * `precomputedFlags` (#10) — without this, `findGroundingSignals` would silently
 * re-run the same O(n^2) pairwise pass internally.
 *
 * `knownCitationIds` for the citation-integrity pass is every claim id and every
 * reference id in this same request: within one review batch, a citation is only
 * "known" if it points at something the reviewer actually submitted alongside it
 * (another claim or a trusted reference), not an open-ended external set.
 */
export function runReview(claims: Claim[], references: TrustedReference[]): ReviewResult {
	const selfConsistency = findInconsistencies(claims);
	const groundingSignals = findGroundingSignals(claims, selfConsistency);
	const referenceConsistency = flagAgainstReferences(claims, references);
	const knownCitationIds = [...claims.map((claim) => claim.id), ...references.map((reference) => reference.id)];
	const citationIntegrity = checkCitationIntegrity(claims, knownCitationIds);

	return { selfConsistency, groundingSignals, referenceConsistency, citationIntegrity };
}

interface ApiError {
	error: string;
	field?: string;
}

function errorResponse(status: number, body: ApiError, extraHeaders?: HeadersInit): Response {
	return Response.json(body, { status, headers: extraHeaders });
}

// Caller-controlled arrays feed findInconsistencies's O(n^2) pairwise pass and
// flagAgainstReferences's O(claims x references) pass (#9) — bounded well above any
// realistic single-record review batch, but far short of a request that could pin CPU.
const MAX_CLAIMS = 200;
const MAX_REFERENCES = 200;
// tokenize()/matchesAnyMarker() in inconsistencyFlagger.ts run several regexes over
// every claim/reference text — a small array of huge strings still costs real CPU/memory
// per request even under the array caps above (#13), so each text field is bounded too.
const MAX_TEXT_LENGTH = 4000;
const MAX_ID_LENGTH = 200;
const MAX_SOURCE_LENGTH = 500;
const MAX_CITATIONS_PER_CLAIM = 50;
const MAX_CITATION_ID_LENGTH = 200;

function isNonEmptyString(value: unknown, maxLength: number): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function parseClaim(raw: unknown, index: number): Claim | { error: Response } {
	if (typeof raw !== "object" || raw === null) {
		return { error: errorResponse(400, { error: `claims[${index}] must be an object`, field: `claims[${index}]` }) };
	}
	const { id, text, citations, confidence } = raw as Record<string, unknown>;

	if (!isNonEmptyString(id, MAX_ID_LENGTH)) {
		return { error: errorResponse(400, { error: "missing, empty, or too-long id", field: `claims[${index}].id` }) };
	}
	if (!isNonEmptyString(text, MAX_TEXT_LENGTH)) {
		return {
			error: errorResponse(400, {
				error: `missing, empty, or over ${MAX_TEXT_LENGTH} characters`,
				field: `claims[${index}].text`,
			}),
		};
	}
	if (!Array.isArray(citations) || citations.length > MAX_CITATIONS_PER_CLAIM) {
		return {
			error: errorResponse(400, {
				error: `citations must be an array of at most ${MAX_CITATIONS_PER_CLAIM} entries`,
				field: `claims[${index}].citations`,
			}),
		};
	}
	if (!citations.every((citation) => typeof citation === "string" && citation.length <= MAX_CITATION_ID_LENGTH)) {
		return {
			error: errorResponse(400, {
				error: `citations must all be strings of at most ${MAX_CITATION_ID_LENGTH} characters`,
				field: `claims[${index}].citations`,
			}),
		};
	}
	if (confidence !== undefined && (typeof confidence !== "number" || confidence < 0 || confidence > 1)) {
		return {
			error: errorResponse(400, { error: "confidence must be a number between 0 and 1", field: `claims[${index}].confidence` }),
		};
	}

	return { id, text, citations, ...(confidence !== undefined ? { confidence } : {}) };
}

function parseReference(raw: unknown, index: number): TrustedReference | { error: Response } {
	if (typeof raw !== "object" || raw === null) {
		return { error: errorResponse(400, { error: `references[${index}] must be an object`, field: `references[${index}]` }) };
	}
	const { id, text, source, sourceUrl } = raw as Record<string, unknown>;

	if (!isNonEmptyString(id, MAX_ID_LENGTH)) {
		return { error: errorResponse(400, { error: "missing, empty, or too-long id", field: `references[${index}].id` }) };
	}
	if (!isNonEmptyString(text, MAX_TEXT_LENGTH)) {
		return {
			error: errorResponse(400, {
				error: `missing, empty, or over ${MAX_TEXT_LENGTH} characters`,
				field: `references[${index}].text`,
			}),
		};
	}
	if (!isNonEmptyString(source, MAX_SOURCE_LENGTH)) {
		return {
			error: errorResponse(400, {
				error: `missing, empty, or over ${MAX_SOURCE_LENGTH} characters`,
				field: `references[${index}].source`,
			}),
		};
	}
	if (sourceUrl !== undefined && !isNonEmptyString(sourceUrl, MAX_SOURCE_LENGTH)) {
		return {
			error: errorResponse(400, {
				error: `must be a non-empty string of at most ${MAX_SOURCE_LENGTH} characters`,
				field: `references[${index}].sourceUrl`,
			}),
		};
	}

	return { id, text, source, ...(sourceUrl !== undefined ? { sourceUrl } : {}) };
}

async function extractReviewRequest(
	request: Request,
): Promise<{ claims: Claim[]; references: TrustedReference[] } | { error: Response }> {
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

	const { claims: rawClaims, references: rawReferences } = parsed as Record<string, unknown>;

	if (!Array.isArray(rawClaims) || rawClaims.length === 0 || rawClaims.length > MAX_CLAIMS) {
		return {
			error: errorResponse(400, {
				error: `claims must be a non-empty array of at most ${MAX_CLAIMS} entries`,
				field: "claims",
			}),
		};
	}
	if (rawReferences !== undefined && (!Array.isArray(rawReferences) || rawReferences.length > MAX_REFERENCES)) {
		return {
			error: errorResponse(400, {
				error: `references must be an array of at most ${MAX_REFERENCES} entries`,
				field: "references",
			}),
		};
	}

	const claims: Claim[] = [];
	for (let i = 0; i < rawClaims.length; i++) {
		const claim = parseClaim(rawClaims[i], i);
		if ("error" in claim) return claim;
		claims.push(claim);
	}

	const references: TrustedReference[] = [];
	const rawReferenceList = (rawReferences as unknown[] | undefined) ?? [];
	for (let i = 0; i < rawReferenceList.length; i++) {
		const reference = parseReference(rawReferenceList[i], i);
		if ("error" in reference) return reference;
		references.push(reference);
	}

	return { claims, references };
}

/**
 * POST /api/review — requires a recipient session, like /api/navigator and /api/qa.
 * Returns the security-headers wrap-up to the caller in src/index.ts (same convention
 * as src/auth/routes.ts's handlers).
 */
export async function handleReview(request: Request, env: AuthEnv): Promise<Response> {
	if (request.method !== "POST") {
		return errorResponse(405, { error: "method not allowed, expected POST" }, { Allow: "POST" });
	}

	const username = await requireSession(request, env);
	if (!username) return unauthorizedResponse();

	const result = await extractReviewRequest(request);
	if ("error" in result) return result.error;

	return Response.json(runReview(result.claims, result.references));
}

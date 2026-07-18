/**
 * Shared pre-parse body-size guard for every POST route's JSON body (#63). Every
 * `await request.json()` call site in this Worker used to parse the full body into
 * memory before any size/shape check ran — a caller could force an unbounded
 * `JSON.parse` regardless of the array-length/text-length caps those routes apply
 * afterward. This checks Content-Length first (fast-reject with no read at all when
 * present and over budget), then enforces the same cap while streaming the body in
 * case Content-Length is absent or understated — a caller controls that header and
 * can simply lie about it, so the streamed count is the real enforcement point.
 */

// Comfortably covers every small JSON POST route in this Worker (login, admin account
// provisioning, the {question} body) without ever letting a caller force a parse of an
// arbitrarily large payload. Routes with legitimately larger bounded input (e.g.
// /api/review's claims/references arrays) pass their own larger, purpose-computed cap.
export const DEFAULT_MAX_BODY_BYTES = 16 * 1024;

export type BodyReadResult =
	| { ok: true; parsed: unknown }
	| { ok: false; kind: "too-large"; maxBytes: number }
	| { ok: false; kind: "invalid-json" };

/**
 * Reads and JSON-parses a request body, rejecting before `JSON.parse` ever runs if the
 * body exceeds `maxBytes` (declared via Content-Length, or measured while streaming).
 */
export async function readJsonBodyWithLimit(request: Request, maxBytes: number = DEFAULT_MAX_BODY_BYTES): Promise<BodyReadResult> {
	const declaredLength = request.headers.get("content-length");
	if (declaredLength !== null) {
		const declaredBytes = Number(declaredLength);
		if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
			return { ok: false, kind: "too-large", maxBytes };
		}
	}

	if (!request.body) return { ok: true, parsed: undefined };

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			return { ok: false, kind: "too-large", maxBytes };
		}
		chunks.push(value);
	}

	const combined = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.byteLength;
	}

	try {
		return { ok: true, parsed: JSON.parse(new TextDecoder().decode(combined)) };
	} catch {
		return { ok: false, kind: "invalid-json" };
	}
}

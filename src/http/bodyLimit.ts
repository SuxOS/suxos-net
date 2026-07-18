/**
 * Shared hard byte-cap body reader for every POST route in this Worker (#63). Every
 * route that used to call `await request.json()` directly would buffer and parse the
 * FULL body into memory before any size/shape check ran — a caller could send an
 * arbitrarily large body (bounded only by Cloudflare's platform-level request-size
 * limit) and force a full JSON.parse before rejection. This reads the body through a
 * streaming reader and aborts the moment the cap is exceeded, so an oversized body is
 * never fully buffered. Content-Length is checked first as a fast path, but is never
 * trusted alone — chunked-encoded or absent Content-Length still hits the streaming
 * cap below.
 */

export const MAX_JSON_BODY_BYTES = 16 * 1024;

export async function readBodyWithLimit(request: Request, maxBytes: number): Promise<{ ok: true; text: string } | { ok: false }> {
	const declaredLength = Number(request.headers.get("content-length") ?? "");
	if (Number.isFinite(declaredLength) && declaredLength > maxBytes) return { ok: false };

	if (!request.body) return { ok: true, text: "" };

	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let received = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		received += value.byteLength;
		if (received > maxBytes) {
			await reader.cancel().catch(() => {});
			return { ok: false };
		}
		chunks.push(value);
	}

	const combined = new Uint8Array(received);
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { ok: true, text: new TextDecoder().decode(combined) };
}

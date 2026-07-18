import { describe, expect, it } from "vitest";
import { readJsonBodyWithLimit } from "./httpBody";

function postRequest(body: string, headers?: HeadersInit): Request {
	return new Request("https://example.invalid/whatever", { method: "POST", body, headers });
}

describe("readJsonBodyWithLimit", () => {
	it("parses a small valid JSON body", async () => {
		const result = await readJsonBodyWithLimit(postRequest(JSON.stringify({ question: "hi" })));
		expect(result).toEqual({ ok: true, parsed: { question: "hi" } });
	});

	it("rejects via Content-Length before reading the body at all, when Content-Length overstates the cap", async () => {
		const result = await readJsonBodyWithLimit(
			postRequest(JSON.stringify({ question: "hi" }), { "content-length": "999999" }),
			10,
		);
		expect(result).toEqual({ ok: false, kind: "too-large", maxBytes: 10 });
	});

	it("rejects once the streamed body exceeds maxBytes, even with no Content-Length header", async () => {
		const result = await readJsonBodyWithLimit(postRequest(JSON.stringify({ question: "x".repeat(1000) })), 50);
		expect(result).toEqual({ ok: false, kind: "too-large", maxBytes: 50 });
	});

	it("returns invalid-json for malformed JSON that is within the size limit", async () => {
		const result = await readJsonBodyWithLimit(postRequest("{not json"));
		expect(result).toEqual({ ok: false, kind: "invalid-json" });
	});

	it("returns ok with undefined parsed for a request with no body", async () => {
		const result = await readJsonBodyWithLimit(new Request("https://example.invalid/whatever"));
		expect(result).toEqual({ ok: true, parsed: undefined });
	});
});

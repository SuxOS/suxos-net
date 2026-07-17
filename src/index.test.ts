import { describe, expect, it, vi } from "vitest";
import worker, { type Env } from "./index";

function createInMemoryKv(): KVNamespace {
	const store = new Map<string, string>();
	return {
		get: async (key: string) => store.get(key) ?? null,
		put: async (key: string, value: string) => {
			store.set(key, value);
		},
	} as unknown as KVNamespace;
}

const ENV: Env = {
	NAV_CACHE: createInMemoryKv(),
	STAGING: "1",
	ACCESS_STAGING_IDENTITY: "dev@localhost",
};

function req(path: string, init?: RequestInit): Request {
	return new Request(`https://suxos-net-staging.example.workers.dev${path}`, init);
}

async function call(path: string, init?: RequestInit): Promise<Response> {
	return worker.fetch(req(path, init), ENV);
}

describe("security headers", () => {
	it("sets nosniff/CSP/referrer-policy on a normal 200 response", async () => {
		const res = await call("/healthz");
		expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
		expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
		expect(res.headers.get("Referrer-Policy")).toBe("no-referrer");
	});

	it("sets security headers on error responses too", async () => {
		const res = await call("/api/navigator?verbosity=essay");
		expect(res.status).toBe(400);
		expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
	});
});

describe("GET /api/navigator", () => {
	it("returns 200 with defaults when no params given", async () => {
		const res = await call("/api/navigator");
		expect(res.status).toBe(200);
	});

	it("returns a structured 400 for an out-of-range verbosity", async () => {
		const res = await call("/api/navigator?verbosity=essay");
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string; field?: string };
		expect(typeof body.error).toBe("string");
		expect(body.field).toBe("verbosity");
	});

	it("returns a structured 400 for an out-of-range timeScope", async () => {
		const res = await call("/api/navigator?timeScope=decade");
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string; field?: string };
		expect(body.field).toBe("timeScope");
	});

	it("returns 405 with an Allow header for a non-GET method", async () => {
		const res = await call("/api/navigator", { method: "POST" });
		expect(res.status).toBe(405);
		expect(res.headers.get("Allow")).toBe("GET");
	});

	it("re-stamps generatedAt on a cache hit instead of returning the cache-fill time", async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-02-01T00:00:00Z"));
			const first = await call("/api/navigator?timeScope=all");
			const firstBody = (await first.json()) as { generatedAt: string; entries: unknown[] };

			vi.setSystemTime(new Date("2026-02-01T00:05:00Z"));
			const second = await call("/api/navigator?timeScope=all");
			const secondBody = (await second.json()) as { generatedAt: string; entries: unknown[] };

			expect(secondBody.entries).toEqual(firstBody.entries);
			expect(new Date(secondBody.generatedAt).getTime()).toBeGreaterThan(new Date(firstBody.generatedAt).getTime());
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("POST /api/qa", () => {
	it("returns 200 for a valid question", async () => {
		const res = await call("/api/qa", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ question: "What happened in March?" }),
		});
		expect(res.status).toBe(200);
	});

	it("returns a structured 400 when question is missing", async () => {
		const res = await call("/api/qa", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string; field?: string };
		expect(body.field).toBe("question");
	});

	it("returns a structured 400 when question is the wrong type", async () => {
		const res = await call("/api/qa", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ question: 12345 }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string; field?: string };
		expect(body.field).toBe("question");
	});

	it("returns a structured 400 for malformed JSON instead of throwing", async () => {
		const res = await call("/api/qa", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{not json",
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(typeof body.error).toBe("string");
	});

	it("returns a structured 400 for a missing Content-Type", async () => {
		const res = await call("/api/qa", {
			method: "POST",
			body: JSON.stringify({ question: "hi" }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string; field?: string };
		expect(body.field).toBe("content-type");
	});

	it("returns 405 with an Allow header for a non-POST method", async () => {
		const res = await call("/api/qa", { method: "GET" });
		expect(res.status).toBe(405);
		expect(res.headers.get("Allow")).toBe("POST");
	});
});

describe("POST /api/review", () => {
	const CLAIMS = [
		{
			id: "claim-a",
			text: "The synthetic widget was present at the sample facility on the test date.",
			citations: ["cite-1"],
		},
		{
			id: "claim-b",
			text: "The synthetic widget was not present at the sample facility on the test date.",
			citations: ["cite-2"],
		},
	];

	it("returns 200 with the aggregated review shape for valid claims", async () => {
		const res = await call("/api/review", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ claims: CLAIMS }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			inconsistencies: unknown[];
			groundingSignals: unknown[];
			referenceFlags: unknown[];
			citationIntegrity: unknown;
			claimsChecked: number;
			generatedAt: string;
		};
		expect(Array.isArray(body.inconsistencies)).toBe(true);
		expect(body.inconsistencies.length).toBeGreaterThan(0);
		expect(Array.isArray(body.groundingSignals)).toBe(true);
		expect(Array.isArray(body.referenceFlags)).toBe(true);
		expect(body.citationIntegrity).toBeNull();
		expect(body.claimsChecked).toBe(2);
		expect(() => new Date(body.generatedAt).toISOString()).not.toThrow();
	});

	it("runs citation-integrity checking when knownCitationIds is supplied", async () => {
		const res = await call("/api/review", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ claims: CLAIMS, knownCitationIds: ["cite-1"] }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { citationIntegrity: { clean: boolean; dangling: unknown[] } };
		expect(body.citationIntegrity.clean).toBe(false);
		expect(body.citationIntegrity.dangling).toEqual([{ recordId: "claim-b", citationId: "cite-2" }]);
	});

	it("runs reference flagging when references is supplied", async () => {
		const res = await call("/api/review", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				claims: [CLAIMS[0]],
				references: [
					{
						id: "ref-1",
						text: "The synthetic widget was not present at the sample facility on the test date.",
						source: "Fictional Reference Manual",
					},
				],
			}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { referenceFlags: { claimId: string }[] };
		expect(body.referenceFlags.length).toBeGreaterThan(0);
		expect(body.referenceFlags[0].claimId).toBe("claim-a");
	});

	it("returns a structured 400 when claims is missing", async () => {
		const res = await call("/api/review", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string; field?: string };
		expect(body.field).toBe("claims");
	});

	it("returns a structured 400 when claims is an empty array", async () => {
		const res = await call("/api/review", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ claims: [] }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string; field?: string };
		expect(body.field).toBe("claims");
	});

	it("returns a structured 400 when claims exceeds the 200-entry cap", async () => {
		const tooManyClaims = Array.from({ length: 201 }, (_, i) => ({
			id: `claim-${i}`,
			text: `Synthetic claim number ${i}.`,
			citations: [],
		}));
		const res = await call("/api/review", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ claims: tooManyClaims }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string; field?: string };
		expect(body.field).toBe("claims");
	});

	it("returns a structured 400 when a claim's text exceeds the length cap", async () => {
		const res = await call("/api/review", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ claims: [{ id: "claim-a", text: "x".repeat(10_001), citations: [] }] }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string; field?: string };
		expect(body.field).toBe("claims");
	});

	it("returns a structured 400 when a claim's citations exceeds the per-claim cap", async () => {
		const res = await call("/api/review", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				claims: [{ id: "claim-a", text: "text", citations: Array.from({ length: 51 }, (_, i) => `cite-${i}`) }],
			}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string; field?: string };
		expect(body.field).toBe("claims");
	});

	it("returns a structured 400 when a citation id exceeds the length cap", async () => {
		const res = await call("/api/review", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ claims: [{ id: "claim-a", text: "text", citations: ["x".repeat(501)] }] }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string; field?: string };
		expect(body.field).toBe("claims");
	});

	it("returns a structured 400 when a reference's text exceeds the length cap", async () => {
		const res = await call("/api/review", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				claims: CLAIMS,
				references: [{ id: "ref-1", text: "x".repeat(10_001), source: "Fictional Reference Manual" }],
			}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string; field?: string };
		expect(body.field).toBe("references");
	});

	it("returns a structured 400 when references exceeds the 200-entry cap", async () => {
		const tooManyReferences = Array.from({ length: 201 }, (_, i) => ({
			id: `ref-${i}`,
			text: `Synthetic reference number ${i}.`,
			source: "Fictional Reference Manual",
		}));
		const res = await call("/api/review", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ claims: CLAIMS, references: tooManyReferences }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string; field?: string };
		expect(body.field).toBe("references");
	});

	it("returns a structured 400 when a claim is malformed", async () => {
		const res = await call("/api/review", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ claims: [{ id: "x" }] }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string; field?: string };
		expect(body.field).toBe("claims");
	});

	it("returns a structured 400 when references is malformed", async () => {
		const res = await call("/api/review", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ claims: CLAIMS, references: [{ id: "ref-1" }] }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string; field?: string };
		expect(body.field).toBe("references");
	});

	it("returns a structured 400 when knownCitationIds is malformed", async () => {
		const res = await call("/api/review", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ claims: CLAIMS, knownCitationIds: [1, 2] }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string; field?: string };
		expect(body.field).toBe("knownCitationIds");
	});

	it("returns a structured 400 for malformed JSON instead of throwing", async () => {
		const res = await call("/api/review", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{not json",
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(typeof body.error).toBe("string");
	});

	it("returns a structured 400 for a missing Content-Type", async () => {
		const res = await call("/api/review", {
			method: "POST",
			body: JSON.stringify({ claims: CLAIMS }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string; field?: string };
		expect(body.field).toBe("content-type");
	});

	it("returns 405 with an Allow header for a non-POST method", async () => {
		const res = await call("/api/review", { method: "GET" });
		expect(res.status).toBe(405);
		expect(res.headers.get("Allow")).toBe("POST");
	});
});

describe("unknown routes", () => {
	it("returns 404 for an unrecognized path", async () => {
		const res = await call("/api/does-not-exist");
		expect(res.status).toBe(404);
	});
});

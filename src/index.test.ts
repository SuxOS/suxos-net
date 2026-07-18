import { describe, expect, it } from "vitest";
import worker, { RateLimitCounter, type Env } from "./index";
import { createInMemoryKv } from "./testUtils/kv";
import { createInMemoryDurableObjectNamespace } from "./testUtils/durableObject";

const ENV: Env = {
	NAV_CACHE: createInMemoryKv(),
	RATE_LIMITER: createInMemoryDurableObjectNamespace((state) => new RateLimitCounter(state)),
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

	it("returns format: standard by default and format: haiku under ?format=haiku", async () => {
		const standardRes = await call("/api/qa", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ question: "What happened in March?" }),
		});
		const standardBody = (await standardRes.json()) as { format: string };
		expect(standardBody.format).toBe("standard");

		const haikuRes = await call("/api/qa?format=haiku", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ question: "What happened in March?" }),
		});
		const haikuBody = (await haikuRes.json()) as { format: string };
		expect(haikuBody.format).toBe("haiku");
	});

	it("returns a structured 400 for an invalid format", async () => {
		const res = await call("/api/qa?format=essay", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ question: "What happened in March?" }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string; field?: string };
		expect(body.field).toBe("format");
	});
});

describe("GET /demo (frontend)", () => {
	it("renders an HTML page, not JSON", async () => {
		const res = await call("/demo");
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toContain("text/html");
		const body = await res.text();
		expect(body).toContain("<title>");
		expect(body).toContain('id="navigator-entries"');
		expect(body).toContain('id="qa-form"');
		expect(body).toContain('id="flags-content"');
	});

	it("sets a same-origin CSP that still allows the page's own script/style/fetch", async () => {
		const res = await call("/demo");
		const csp = res.headers.get("Content-Security-Policy") ?? "";
		expect(csp).toContain("script-src 'self'");
		expect(csp).toContain("style-src 'self'");
		expect(csp).toContain("connect-src 'self'");
		expect(csp).not.toContain("unsafe-inline");
	});

	it("returns 405 with an Allow header for a non-GET method", async () => {
		const res = await call("/demo", { method: "POST" });
		expect(res.status).toBe(405);
		expect(res.headers.get("Allow")).toBe("GET");
	});

	it("also renders at the trailing-slash path", async () => {
		const res = await call("/demo/");
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toContain("text/html");
	});

	it("serves app.css as CSS", async () => {
		const res = await call("/demo/app.css");
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toContain("text/css");
	});

	it("serves app.js as JS", async () => {
		const res = await call("/demo/app.js");
		expect(res.status).toBe(200);
		expect(res.headers.get("Content-Type")).toContain("javascript");
		const body = await res.text();
		expect(body).toContain("/demo/navigator");
		expect(body).toContain("/demo/qa");
		expect(body).toContain("/demo/flags");
	});
});

describe("rate limiting on /api/*", () => {
	function freshRateLimitEnv(): Env {
		return {
			...ENV,
			NAV_CACHE: createInMemoryKv(),
			RATE_LIMITER: createInMemoryDurableObjectNamespace((state) => new RateLimitCounter(state)),
		};
	}

	it("allows requests under the limit", async () => {
		const env = freshRateLimitEnv();
		const res = await worker.fetch(req("/api/navigator", { headers: { "CF-Connecting-IP": "1.2.3.4" } }), env);
		expect(res.status).toBe(200);
	});

	it("returns 429 with Retry-After once a client exceeds the window limit", async () => {
		const env = freshRateLimitEnv();
		const ip = "5.6.7.8";
		let last: Response | undefined;
		for (let i = 0; i < 61; i++) {
			last = await worker.fetch(req("/api/navigator", { headers: { "CF-Connecting-IP": ip } }), env);
		}
		expect(last?.status).toBe(429);
		expect(last?.headers.get("Retry-After")).toBe("60");
	});

	it("tracks limits per client independently", async () => {
		const env = freshRateLimitEnv();
		for (let i = 0; i < 60; i++) {
			await worker.fetch(req("/api/navigator", { headers: { "CF-Connecting-IP": "9.9.9.9" } }), env);
		}
		const otherClient = await worker.fetch(req("/api/navigator", { headers: { "CF-Connecting-IP": "1.1.1.1" } }), env);
		expect(otherClient.status).toBe(200);
	});

	it("does not rate-limit non-/api/ routes", async () => {
		const env = freshRateLimitEnv();
		let last: Response | undefined;
		for (let i = 0; i < 65; i++) {
			last = await worker.fetch(req("/healthz", { headers: { "CF-Connecting-IP": "2.2.2.2" } }), env);
		}
		expect(last?.status).toBe(200);
	});

	it("never allows more than the max requests through, even when issued concurrently", async () => {
		const env = freshRateLimitEnv();
		const ip = "3.3.3.3";
		const responses = await Promise.all(
			Array.from({ length: 70 }, () => worker.fetch(req("/api/navigator", { headers: { "CF-Connecting-IP": ip } }), env)),
		);
		const allowed = responses.filter((r) => r.status === 200).length;
		expect(allowed).toBe(60);
	});
});

describe("unknown routes", () => {
	it("returns 404 for an unrecognized path", async () => {
		const res = await call("/api/does-not-exist");
		expect(res.status).toBe(404);
	});
});

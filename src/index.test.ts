import { describe, expect, it } from "vitest";
import worker, { type Env } from "./index";

const ENV: Env = {
	NAV_CACHE: {} as KVNamespace,
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
});

describe("unknown routes", () => {
	it("returns 404 for an unrecognized path", async () => {
		const res = await call("/api/does-not-exist");
		expect(res.status).toBe(404);
	});
});

describe("GET /admin/audit-log", () => {
	it("records /api/navigator and /api/qa reads and returns them read-only", async () => {
		await call("/api/navigator?verbosity=oneline&timeScope=week");
		await call("/api/qa", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ question: "What happened in March?" }),
		});

		const res = await call("/admin/audit-log");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { entries: Array<{ route: string; identity: string }> };
		expect(body.entries.some((e) => e.route === "/api/navigator")).toBe(true);
		expect(body.entries.some((e) => e.route === "/api/qa")).toBe(true);
		expect(body.entries.every((e) => e.identity === "dev@localhost")).toBe(true);
	});

	it("returns 405 with Allow: GET for a non-GET method", async () => {
		const res = await call("/admin/audit-log", { method: "POST" });
		expect(res.status).toBe(405);
		expect(res.headers.get("Allow")).toBe("GET");
	});
});

describe("GET /demo/access/whoami (feature-flagged)", () => {
	it("404s when ACCESS_SCOPING_ENABLED is unset, same as any unknown route", async () => {
		const res = await call("/demo/access/whoami?identity=demo-care-team@example.invalid");
		expect(res.status).toBe(404);
	});
});

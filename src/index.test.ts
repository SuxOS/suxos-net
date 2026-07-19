import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "./index";
import { createMemoryKv } from "./test/kvMock";
import { createRateLimiterNamespace } from "./test/doMock";

let ENV: Env;

const OPERATOR_TOKEN = "test-operator-token-do-not-use-in-prod";

beforeEach(() => {
	const kv = createMemoryKv();
	ENV = {
		NAV_CACHE: kv,
		RATE_LIMITER: createRateLimiterNamespace(kv),
		STAGING: "1",
		ACCESS_STAGING_IDENTITY: "dev@localhost",
		SESSION_SECRET: "test-session-secret-do-not-use-in-prod",
		OPERATOR_TOKEN,
	};
});

function req(path: string, init?: RequestInit): Request {
	return new Request(`https://suxos-net-staging.example.workers.dev${path}`, init);
}

async function call(path: string, init?: RequestInit): Promise<Response> {
	return worker.fetch(req(path, init), ENV);
}

function jsonBody(body: unknown): RequestInit {
	return { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

/** Like jsonBody but adds the operator bearer token required by /admin/* routes. */
function adminBody(body: unknown): RequestInit {
	return {
		method: "POST",
		headers: { "content-type": "application/json", Authorization: `Bearer ${OPERATOR_TOKEN}` },
		body: JSON.stringify(body),
	};
}

/** Extracts just the `name=value` portion of a Set-Cookie header for reuse as a request Cookie header. */
function cookieHeaderFrom(setCookie: string | null): string {
	if (!setCookie) throw new Error("expected a Set-Cookie header");
	return setCookie.split(";")[0];
}

async function createAccountAndLogin(username: string, password: string, env: Env = ENV): Promise<string> {
	const createRes = await worker.fetch(req("/admin/accounts", adminBody({ username, password })), env);
	expect(createRes.status).toBe(201);
	const loginRes = await worker.fetch(req("/login", jsonBody({ username, password })), env);
	expect(loginRes.status).toBe(200);
	return cookieHeaderFrom(loginRes.headers.get("Set-Cookie"));
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
		// unauthenticated, but the 401 itself must still carry security headers
		expect(res.status).toBe(401);
		expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
	});
});

describe("GET /api/navigator (requires a recipient session)", () => {
	it("returns 401 with no session cookie", async () => {
		const res = await call("/api/navigator");
		expect(res.status).toBe(401);
		const body = (await res.json()) as { error: string };
		expect(typeof body.error).toBe("string");
	});

	it("returns 200 with defaults when a valid session cookie is present", async () => {
		const cookie = await createAccountAndLogin("alice", "correct horse battery staple");
		const res = await call("/api/navigator", { headers: { Cookie: cookie } });
		expect(res.status).toBe(200);
	});

	it("re-stamps generatedAt to the actual response time on a cache hit (#7)", async () => {
		const cookie = await createAccountAndLogin("alice", "correct horse battery staple");
		vi.useFakeTimers();
		try {
			vi.setSystemTime(1_700_000_000_000);
			const first = await call("/api/navigator", { headers: { Cookie: cookie } });
			const firstBody = (await first.json()) as { generatedAt: string };
			expect(firstBody.generatedAt).toBe(new Date(1_700_000_000_000).toISOString());

			vi.setSystemTime(1_700_000_060_000); // 60s later, still within the 5min cache TTL
			const second = await call("/api/navigator", { headers: { Cookie: cookie } });
			const secondBody = (await second.json()) as { generatedAt: string };
			expect(secondBody.generatedAt).toBe(new Date(1_700_000_060_000).toISOString());
		} finally {
			vi.useRealTimers();
		}
	});

	it("returns a structured 400 for an out-of-range verbosity", async () => {
		const cookie = await createAccountAndLogin("alice", "correct horse battery staple");
		const res = await call("/api/navigator?verbosity=essay", { headers: { Cookie: cookie } });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string; field?: string };
		expect(typeof body.error).toBe("string");
		expect(body.field).toBe("verbosity");
	});

	it("returns a structured 400 for an out-of-range timeScope", async () => {
		const cookie = await createAccountAndLogin("alice", "correct horse battery staple");
		const res = await call("/api/navigator?timeScope=decade", { headers: { Cookie: cookie } });
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string; field?: string };
		expect(body.field).toBe("timeScope");
	});

	it("returns 405 with an Allow header for a non-GET method", async () => {
		const cookie = await createAccountAndLogin("alice", "correct horse battery staple");
		const res = await call("/api/navigator", { method: "POST", headers: { Cookie: cookie } });
		expect(res.status).toBe(405);
		expect(res.headers.get("Allow")).toBe("GET");
	});
});

describe("POST /api/qa (requires a recipient session)", () => {
	it("returns 401 with no session cookie", async () => {
		const res = await call("/api/qa", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ question: "What happened in March?" }),
		});
		expect(res.status).toBe(401);
	});

	it("returns 200 for a valid question with a valid session", async () => {
		const cookie = await createAccountAndLogin("alice", "correct horse battery staple");
		const res = await call("/api/qa", {
			method: "POST",
			headers: { "content-type": "application/json", Cookie: cookie },
			body: JSON.stringify({ question: "What happened in March?" }),
		});
		expect(res.status).toBe(200);
	});

	it("returns a structured 400 when question is missing", async () => {
		const cookie = await createAccountAndLogin("alice", "correct horse battery staple");
		const res = await call("/api/qa", {
			method: "POST",
			headers: { "content-type": "application/json", Cookie: cookie },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string; field?: string };
		expect(body.field).toBe("question");
	});

	it("returns a structured 400 when question is the wrong type", async () => {
		const cookie = await createAccountAndLogin("alice", "correct horse battery staple");
		const res = await call("/api/qa", {
			method: "POST",
			headers: { "content-type": "application/json", Cookie: cookie },
			body: JSON.stringify({ question: 12345 }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string; field?: string };
		expect(body.field).toBe("question");
	});

	it("returns a structured 400 for malformed JSON instead of throwing", async () => {
		const cookie = await createAccountAndLogin("alice", "correct horse battery staple");
		const res = await call("/api/qa", {
			method: "POST",
			headers: { "content-type": "application/json", Cookie: cookie },
			body: "{not json",
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(typeof body.error).toBe("string");
	});

	it("returns a structured 400 for a missing Content-Type", async () => {
		const cookie = await createAccountAndLogin("alice", "correct horse battery staple");
		const res = await call("/api/qa", {
			method: "POST",
			headers: { Cookie: cookie },
			body: JSON.stringify({ question: "hi" }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string; field?: string };
		expect(body.field).toBe("content-type");
	});

	it("returns 405 with an Allow header for a non-POST method", async () => {
		const cookie = await createAccountAndLogin("alice", "correct horse battery staple");
		const res = await call("/api/qa", { method: "GET", headers: { Cookie: cookie } });
		expect(res.status).toBe(405);
		expect(res.headers.get("Allow")).toBe("POST");
	});

	it("returns 413 for an oversized body instead of parsing it (#63)", async () => {
		const cookie = await createAccountAndLogin("alice", "correct horse battery staple");
		const res = await call("/api/qa", {
			method: "POST",
			headers: { "content-type": "application/json", Cookie: cookie },
			body: JSON.stringify({ question: "x".repeat(100_000) }),
		});
		expect(res.status).toBe(413);
	});
});

describe("POST /api/review (requires a recipient session)", () => {
	const VALID_CLAIMS = [
		{ id: "claim-a", text: "The synthetic widget was present at the sample facility.", citations: [] },
		{ id: "claim-b", text: "The synthetic widget was not present at the sample facility.", citations: [] },
	];

	function reviewBody(cookie: string, body: unknown): RequestInit {
		return { method: "POST", headers: { "content-type": "application/json", Cookie: cookie }, body: JSON.stringify(body) };
	}

	it("returns 401 with no session cookie", async () => {
		const res = await call("/api/review", jsonBody({ claims: VALID_CLAIMS }));
		expect(res.status).toBe(401);
	});

	it("returns 200 with all four review dimensions for a valid session and body", async () => {
		const cookie = await createAccountAndLogin("alice", "correct horse battery staple");
		const res = await call("/api/review", reviewBody(cookie, { claims: VALID_CLAIMS }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body).toHaveProperty("selfConsistency");
		expect(body).toHaveProperty("groundingSignals");
		expect(body).toHaveProperty("referenceConsistency");
		expect(body).toHaveProperty("citationIntegrity");
	});

	it("returns a structured 400 when claims is missing", async () => {
		const cookie = await createAccountAndLogin("alice", "correct horse battery staple");
		const res = await call("/api/review", reviewBody(cookie, {}));
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string; field?: string };
		expect(body.field).toBe("claims");
	});

	it("returns a structured 400 when claims is an empty array", async () => {
		const cookie = await createAccountAndLogin("alice", "correct horse battery staple");
		const res = await call("/api/review", reviewBody(cookie, { claims: [] }));
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string; field?: string };
		expect(body.field).toBe("claims");
	});

	it("returns a structured 400 when claims exceeds the array-length cap (#9)", async () => {
		const cookie = await createAccountAndLogin("alice", "correct horse battery staple");
		const tooMany = Array.from({ length: 201 }, (_, i) => ({ id: `claim-${i}`, text: "filler synthetic text", citations: [] }));
		const res = await call("/api/review", reviewBody(cookie, { claims: tooMany }));
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string; field?: string };
		expect(body.field).toBe("claims");
	});

	it("returns a structured 400 when a claim's text exceeds the per-field length cap (#13)", async () => {
		const cookie = await createAccountAndLogin("alice", "correct horse battery staple");
		const oversized = [{ id: "claim-huge", text: "x".repeat(4001), citations: [] }];
		const res = await call("/api/review", reviewBody(cookie, { claims: oversized }));
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string; field?: string };
		expect(body.field).toBe("claims[0].text");
	});

	it("returns a structured 400 when a claim is missing an id", async () => {
		const cookie = await createAccountAndLogin("alice", "correct horse battery staple");
		const invalid = [{ text: "no id here", citations: [] }];
		const res = await call("/api/review", reviewBody(cookie, { claims: invalid }));
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string; field?: string };
		expect(body.field).toBe("claims[0].id");
	});

	it("rejects a references field in the request body (#19 runtime guard: curated-store-only)", async () => {
		const cookie = await createAccountAndLogin("alice", "correct horse battery staple");
		const attemptedInjection = [{ id: "ref-injected", text: "not curated", source: "not curated source" }];
		const res = await call("/api/review", reviewBody(cookie, { claims: VALID_CLAIMS, references: attemptedInjection }));
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string; field?: string };
		expect(body.field).toBe("references");
	});

	it("returns 413 when the body exceeds the byte-size limit (#63)", async () => {
		const cookie = await createAccountAndLogin("alice", "correct horse battery staple");
		const hugeClaims = [{ id: "claim-huge", text: "x".repeat(5_000_000), citations: [] }];
		const res = await call("/api/review", reviewBody(cookie, { claims: hugeClaims }));
		expect(res.status).toBe(413);
	});

	it("uses only curated (not caller-supplied) references for reference-consistency flags (#19)", async () => {
		const cookie = await createAccountAndLogin("alice", "correct horse battery staple");
		await call(
			"/admin/references",
			adminBody({
				id: "ref-curated-1",
				text: "Synthetic Compound Zeta is metabolized by the synthetic pathway.",
				source: "SYNTHETIC-TEST Reference Manual, fictional edition",
				curator: "test-curator",
				scopeOfApplicability: "fictional demo persona only",
			}),
		);

		const conflictingClaim = [
			{
				id: "claim-conflict",
				text: "Synthetic Compound Zeta is not metabolized by the synthetic pathway.",
				citations: [],
			},
		];
		const res = await call("/api/review", reviewBody(cookie, { claims: conflictingClaim }));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { referenceConsistency: Array<{ appearsInconsistentWith: string }> };
		expect(body.referenceConsistency.some((flag) => flag.appearsInconsistentWith === "ref-curated-1")).toBe(true);
	});

	it("returns 405 with an Allow header for a non-POST method", async () => {
		const cookie = await createAccountAndLogin("alice", "correct horse battery staple");
		const res = await call("/api/review", { method: "GET", headers: { Cookie: cookie } });
		expect(res.status).toBe(405);
		expect(res.headers.get("Allow")).toBe("POST");
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
	function envWithFreshKv(): Env {
		// Fresh DO namespace too — the accumulation tests below depend on starting from
		// an empty per-IP counter, exactly as they depend on a fresh KV. Both must share
		// the same KV instance: account creation (via the DO) and login (direct KV read)
		// need to see the same data.
		const kv = createMemoryKv();
		return { ...ENV, NAV_CACHE: kv, RATE_LIMITER: createRateLimiterNamespace(kv) };
	}

	// The limiter uses a fixed-window counter keyed on Math.floor(Date.now() / window)
	// (see checkRateLimit). These accumulation tests fire 60+ requests in one loop and
	// assert the budget trips; that invariant only holds if every request lands in the
	// SAME wall-clock window. The slow /login and /admin sprays (a real hash per request)
	// take ~3s, so on a real (unfrozen) clock the loop can straddle a 60s boundary, reset
	// the bucket mid-flight, and let the final request through — a genuine wall-clock flake
	// that turned CI red on the /login case. Freeze the clock to a fixed mid-window instant
	// so all requests share one bucket. This still exercises the real per-IP accumulation:
	// 61 requests from one IP against a stable window must exhaust the 60-request budget.
	beforeEach(() => {
		vi.spyOn(Date, "now").mockReturnValue(1_700_000_030_000);
	});
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("allows requests under the limit", async () => {
		const env = envWithFreshKv();
		const cookie = await createAccountAndLogin("rate-limit-under", "correct horse battery staple", env);
		const res = await worker.fetch(
			req("/api/navigator", { headers: { "CF-Connecting-IP": "1.2.3.4", Cookie: cookie } }),
			env,
		);
		expect(res.status).toBe(200);
	});

	it("returns 429 with Retry-After once a client exceeds the window limit", async () => {
		const env = envWithFreshKv();
		const ip = "5.6.7.8";
		let last: Response | undefined;
		for (let i = 0; i < 61; i++) {
			last = await worker.fetch(req("/api/navigator", { headers: { "CF-Connecting-IP": ip } }), env);
		}
		expect(last?.status).toBe(429);
		expect(last?.headers.get("Retry-After")).toBe("60");
	});

	it("tracks limits per client independently", async () => {
		const env = envWithFreshKv();
		const cookie = await createAccountAndLogin("rate-limit-per-client", "correct horse battery staple", env);
		for (let i = 0; i < 60; i++) {
			await worker.fetch(req("/api/navigator", { headers: { "CF-Connecting-IP": "9.9.9.9", Cookie: cookie } }), env);
		}
		const otherClient = await worker.fetch(
			req("/api/navigator", { headers: { "CF-Connecting-IP": "1.1.1.1", Cookie: cookie } }),
			env,
		);
		expect(otherClient.status).toBe(200);
	});

	it("does not rate-limit non-/api/ routes", async () => {
		const env = envWithFreshKv();
		let last: Response | undefined;
		for (let i = 0; i < 65; i++) {
			last = await worker.fetch(req("/healthz", { headers: { "CF-Connecting-IP": "2.2.2.2" } }), env);
		}
		expect(last?.status).toBe(200);
	});

	it("IP-rate-limits /login to blunt password spraying (429 after the window budget)", async () => {
		const env = envWithFreshKv();
		const ip = "3.3.3.3";
		// Spray the SAME password across many distinct usernames — the per-username
		// lockout never trips (one failed attempt each), so only the per-IP limiter
		// stops this. Once the IP budget is exhausted, requests get a 429.
		let last: Response | undefined;
		for (let i = 0; i < 61; i++) {
			last = await worker.fetch(
				req("/login", { method: "POST", headers: { "content-type": "application/json", "CF-Connecting-IP": ip }, body: JSON.stringify({ username: `sprayed-${i}`, password: "one-guessed-password" }) }),
				env,
			);
		}
		expect(last?.status).toBe(429);
		expect(last?.headers.get("Retry-After")).toBe("60");
		// 61 real /login attempts each run the constant-time decoy hash (deliberately
		// slow to defeat username-enumeration timing) — extend past vitest's 5s default.
	}, 30000);

	it("IP-rate-limits /admin/* routes (429 after the window budget)", async () => {
		const env = envWithFreshKv();
		const ip = "4.4.4.4";
		let last: Response | undefined;
		for (let i = 0; i < 61; i++) {
			last = await worker.fetch(
				req("/admin/accounts", { method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${OPERATOR_TOKEN}`, "CF-Connecting-IP": ip }, body: JSON.stringify({ username: `admin-flood-${i}`, password: "operator-set-password-1" }) }),
				env,
			);
		}
		expect(last?.status).toBe(429);
		expect(last?.headers.get("Retry-After")).toBe("60");
		// 61 real account provisions each hash the password on store — extend past 5s.
	}, 30000);
});

describe("unknown routes", () => {
	it("returns 404 for an unrecognized path", async () => {
		const res = await call("/api/does-not-exist");
		expect(res.status).toBe(404);
	});
});

describe("access audit log (#20)", () => {
	it("records a navigator read with the recipient identity and the entry ids viewed, not their body text", async () => {
		const cookie = await createAccountAndLogin("alice", "correct horse battery staple");
		const res = await call("/api/navigator", { headers: { Cookie: cookie } });
		expect(res.status).toBe(200);
		const navBody = (await res.json()) as { entries: { id: string; body: string | null }[] };

		const auditRes = await call("/admin/audit-log", { headers: { Authorization: `Bearer ${OPERATOR_TOKEN}` } });
		const { entries } = (await auditRes.json()) as {
			entries: { identity: { kind: string; username?: string }; detail: Record<string, unknown> }[];
		};
		const navEntry = entries.find((e) => e.detail.kind === "navigator");
		expect(navEntry?.identity).toEqual({ kind: "recipient-username", username: "alice" });
		expect(navEntry?.detail.entryIds).toEqual(navBody.entries.map((e) => e.id));
		expect(JSON.stringify(navEntry?.detail)).not.toContain(navBody.entries[0]?.body ?? "\0impossible\0");
	});

	it("records a QA answer with the query and citations, never the synthesized answer text", async () => {
		const cookie = await createAccountAndLogin("alice", "correct horse battery staple");
		const res = await call("/api/qa", {
			method: "POST",
			headers: { "content-type": "application/json", Cookie: cookie },
			body: JSON.stringify({ question: "What happened in March?" }),
		});
		const qaBody = (await res.json()) as { answer: string; citations: string[]; status: string };

		const auditRes = await call("/admin/audit-log", { headers: { Authorization: `Bearer ${OPERATOR_TOKEN}` } });
		const { entries } = (await auditRes.json()) as { entries: { detail: Record<string, unknown> }[] };
		const qaEntry = entries.find((e) => e.detail.kind === "qa");
		expect(qaEntry?.detail).toEqual({ kind: "qa", question: "What happened in March?", citationIds: qaBody.citations, status: qaBody.status });
		expect(qaEntry?.detail).not.toHaveProperty("answer");
	});

	describe("GET /admin/audit-log (operator-only, read-only)", () => {
		it("rejects with no operator token (401)", async () => {
			const res = await call("/admin/audit-log");
			expect(res.status).toBe(401);
		});

		it("rejects a wrong operator token (401)", async () => {
			const res = await call("/admin/audit-log", { headers: { Authorization: "Bearer wrong-operator-token" } });
			expect(res.status).toBe(401);
		});

		it("returns 405 with an Allow header for a non-GET method", async () => {
			const res = await call("/admin/audit-log", { method: "POST", headers: { Authorization: `Bearer ${OPERATOR_TOKEN}` } });
			expect(res.status).toBe(405);
			expect(res.headers.get("Allow")).toBe("GET");
		});

		it("returns 200 with an entries array for a valid operator token", async () => {
			const res = await call("/admin/audit-log", { headers: { Authorization: `Bearer ${OPERATOR_TOKEN}` } });
			expect(res.status).toBe(200);
			const body = (await res.json()) as { entries: unknown[]; cursor: string | null };
			expect(Array.isArray(body.entries)).toBe(true);
		});
	});
});

describe("trusted-reference curation (#19)", () => {
	const FICTIONAL_REFERENCE = {
		id: "ref-demo-1",
		text: "Fictional Compound Gamma has a demo interaction with fictional Compound Delta.",
		source: "SYNTHETIC-TEST Reference Manual, fictional edition",
		curator: "test-curator",
		scopeOfApplicability: "fictional demo persona only",
	};

	describe("POST /admin/references (operator-only create)", () => {
		it("rejects with no operator token (401)", async () => {
			const res = await call("/admin/references", jsonBody(FICTIONAL_REFERENCE));
			expect(res.status).toBe(401);
		});

		it("creates a reference and rejects a duplicate id", async () => {
			const first = await call("/admin/references", adminBody(FICTIONAL_REFERENCE));
			expect(first.status).toBe(201);
			const created = (await first.json()) as { id: string; dateAdded: string };
			expect(created.id).toBe(FICTIONAL_REFERENCE.id);
			expect(typeof created.dateAdded).toBe("string");

			const dupe = await call("/admin/references", adminBody(FICTIONAL_REFERENCE));
			expect(dupe.status).toBe(409);
		});

		it("returns a structured 400 for a missing field", async () => {
			const { curator: _curator, ...missingCurator } = FICTIONAL_REFERENCE;
			const res = await call("/admin/references", adminBody(missingCurator));
			expect(res.status).toBe(400);
			const body = (await res.json()) as { field?: string };
			expect(body.field).toBe("curator");
		});
	});

	describe("GET /admin/references (operator-only list)", () => {
		it("rejects with no operator token (401)", async () => {
			const res = await call("/admin/references");
			expect(res.status).toBe(401);
		});

		it("lists a created reference", async () => {
			await call("/admin/references", adminBody(FICTIONAL_REFERENCE));
			const res = await call("/admin/references", { headers: { Authorization: `Bearer ${OPERATOR_TOKEN}` } });
			expect(res.status).toBe(200);
			const body = (await res.json()) as { references: Array<{ id: string }> };
			expect(body.references.some((reference) => reference.id === FICTIONAL_REFERENCE.id)).toBe(true);
		});
	});

	describe("POST /admin/references/update and /admin/references/delete", () => {
		it("updates a field without touching dateAdded", async () => {
			const createRes = await call("/admin/references", adminBody(FICTIONAL_REFERENCE));
			const created = (await createRes.json()) as { dateAdded: string };

			const updateRes = await call(
				"/admin/references/update",
				adminBody({ id: FICTIONAL_REFERENCE.id, text: "Updated fictional text." }),
			);
			expect(updateRes.status).toBe(200);
			const updated = (await updateRes.json()) as { text: string; dateAdded: string };
			expect(updated.text).toBe("Updated fictional text.");
			expect(updated.dateAdded).toBe(created.dateAdded);
		});

		it("returns 404 updating a reference that does not exist", async () => {
			const res = await call("/admin/references/update", adminBody({ id: "no-such-ref", text: "x" }));
			expect(res.status).toBe(404);
		});

		it("deletes a reference, after which it no longer appears in the list", async () => {
			await call("/admin/references", adminBody(FICTIONAL_REFERENCE));
			const deleteRes = await call("/admin/references/delete", adminBody({ id: FICTIONAL_REFERENCE.id }));
			expect(deleteRes.status).toBe(200);

			const listRes = await call("/admin/references", { headers: { Authorization: `Bearer ${OPERATOR_TOKEN}` } });
			const body = (await listRes.json()) as { references: Array<{ id: string }> };
			expect(body.references.some((reference) => reference.id === FICTIONAL_REFERENCE.id)).toBe(false);
		});

		it("returns 404 deleting a reference that does not exist", async () => {
			const res = await call("/admin/references/delete", adminBody({ id: "no-such-ref" }));
			expect(res.status).toBe(404);
		});
	});
});

describe("recipient auth (#18)", () => {
	describe("POST /admin/accounts (operator-only provisioning)", () => {
		it("creates an account and rejects a duplicate username", async () => {
			const first = await call("/admin/accounts", adminBody({ username: "bob", password: "operator-set-password-1" }));
			expect(first.status).toBe(201);

			const dupe = await call("/admin/accounts", adminBody({ username: "bob", password: "some-other-password" }));
			expect(dupe.status).toBe(409);
		});

		it("rejects a password shorter than 8 characters", async () => {
			const res = await call("/admin/accounts", adminBody({ username: "shorty", password: "short" }));
			expect(res.status).toBe(409);
		});

		it("rejects provisioning with no operator token (401), and creates no account", async () => {
			const res = await call("/admin/accounts", jsonBody({ username: "mallory", password: "attacker-chosen-pw-1" }));
			expect(res.status).toBe(401);
			expect(res.headers.get("WWW-Authenticate")).toBe("Bearer");
			// the would-be account must not exist — no self-provisioning happened
			expect(await ENV.NAV_CACHE.get("auth:account:mallory")).toBeNull();
		});

		it("rejects provisioning with a wrong operator token (401)", async () => {
			const res = await call("/admin/accounts", {
				method: "POST",
				headers: { "content-type": "application/json", Authorization: "Bearer wrong-operator-token" },
				body: JSON.stringify({ username: "mallory", password: "attacker-chosen-pw-1" }),
			});
			expect(res.status).toBe(401);
		});

		it("fails closed when OPERATOR_TOKEN is unset — even a bearer header is rejected", async () => {
			const env: Env = { ...ENV, NAV_CACHE: createMemoryKv(), OPERATOR_TOKEN: "" };
			const res = await worker.fetch(req("/admin/accounts", adminBody({ username: "mallory", password: "attacker-chosen-pw-1" })), env);
			expect(res.status).toBe(401);
			expect(await env.NAV_CACHE.get("auth:account:mallory")).toBeNull();
		});
	});

	describe("POST /login", () => {
		it("logs in with correct credentials and sets an HttpOnly Secure SameSite=Strict cookie", async () => {
			await call("/admin/accounts", adminBody({ username: "carol", password: "a-real-password-123" }));
			const res = await call("/login", jsonBody({ username: "carol", password: "a-real-password-123" }));
			expect(res.status).toBe(200);

			const setCookie = res.headers.get("Set-Cookie");
			expect(setCookie).toBeTruthy();
			expect(setCookie).toContain("HttpOnly");
			expect(setCookie).toContain("Secure");
			expect(setCookie).toContain("SameSite=Strict");
			expect(setCookie).toMatch(/^suxos_session=/);
		});

		it("keeps a dotted username authenticated on the request AFTER login, not just at login (#80)", async () => {
			// Before the fix, verifySessionToken split on "." expecting exactly 3 parts, so
			// a dotted username like "jane.doe" produced a 4-part token that failed the
			// length check on every request AFTER the one that set the cookie — login itself
			// never calls verifySessionToken, so it always looked like it "worked".
			const cookie = await createAccountAndLogin("jane.doe", "a-real-password-99");
			const res = await call("/api/navigator", { headers: { Cookie: cookie } });
			expect(res.status).toBe(200);
		});

		it("rejects a wrong password with a generic 401", async () => {
			await call("/admin/accounts", adminBody({ username: "dave", password: "correct-password-here" }));
			const res = await call("/login", jsonBody({ username: "dave", password: "wrong-password-here" }));
			expect(res.status).toBe(401);
			const body = (await res.json()) as { error: string };
			expect(body.error).toBe("invalid username or password");
		});

		it("rejects login for a username that was never created, with the SAME generic message (no enumeration)", async () => {
			const res = await call("/login", jsonBody({ username: "nobody", password: "whatever-password" }));
			expect(res.status).toBe(401);
			const body = (await res.json()) as { error: string };
			expect(body.error).toBe("invalid username or password");
		});

		it("returns an identical error shape for a missing user and a wrong password (no timing/response enumeration)", async () => {
			await call("/admin/accounts", adminBody({ username: "grace", password: "correct-password-here" }));

			const wrongPasswordRes = await call("/login", jsonBody({ username: "grace", password: "wrong-password-here" }));
			const missingUserRes = await call("/login", jsonBody({ username: "ghost", password: "wrong-password-here" }));

			expect(missingUserRes.status).toBe(wrongPasswordRes.status);
			expect(missingUserRes.status).toBe(401);
			const missingBody = (await missingUserRes.json()) as { error: string };
			const wrongBody = (await wrongPasswordRes.json()) as { error: string };
			expect(missingBody).toEqual(wrongBody);
			expect(missingBody.error).toBe("invalid username or password");
		});

		it("locks out after repeated failed attempts (rate limiting)", async () => {
			await call("/admin/accounts", adminBody({ username: "erin", password: "correct-password-here" }));

			let lastStatus = 0;
			for (let i = 0; i < 5; i++) {
				const res = await call("/login", jsonBody({ username: "erin", password: "wrong-password" }));
				lastStatus = res.status;
			}
			expect(lastStatus).toBe(401);

			// 6th attempt (even with the CORRECT password) should now be locked out.
			const lockedRes = await call("/login", jsonBody({ username: "erin", password: "correct-password-here" }));
			expect(lockedRes.status).toBe(429);
			expect(lockedRes.headers.get("Retry-After")).toBeTruthy();
		});

		it("returns 413 for an oversized body instead of parsing it (#63)", async () => {
			const res = await call("/login", jsonBody({ username: "x".repeat(100_000), password: "whatever" }));
			expect(res.status).toBe(413);
		});

		it("holds the lockout under a CONCURRENT burst — closes the check/record straddle (#35)", async () => {
			await call("/admin/accounts", adminBody({ username: "frank", password: "correct-password-here" }));

			// 20 simultaneous wrong-password guesses against ONE username. The old flow
			// read the lock, ran a slow PBKDF2, then recorded a failure as separate steps,
			// so a burst all passed the read before anything was recorded and every guess
			// reached the verify. Atomic admission counts each at entry: at most 5 reach the
			// verify (401), the rest are locked out (429) before any PBKDF2 runs.
			const burst = 20;
			const results = await Promise.all(
				Array.from({ length: burst }, () => call("/login", jsonBody({ username: "frank", password: "wrong-password" }))),
			);
			const statuses = results.map((r) => r.status);
			const reachedVerify = statuses.filter((s) => s === 401).length;
			const lockedOut = statuses.filter((s) => s === 429).length;
			expect(reachedVerify).toBeLessThanOrEqual(5);
			expect(lockedOut).toBeGreaterThanOrEqual(burst - 5);
			expect(reachedVerify + lockedOut).toBe(burst);
		});
	});

	describe("POST /admin/accounts/reset", () => {
		it("resets a recipient's password directly, and the new password works while the old one doesn't", async () => {
			await call("/admin/accounts", adminBody({ username: "frank", password: "original-password-1" }));

			const resetRes = await call("/admin/accounts/reset", adminBody({ username: "frank", password: "brand-new-password-1" }));
			expect(resetRes.status).toBe(200);

			const oldLogin = await call("/login", jsonBody({ username: "frank", password: "original-password-1" }));
			expect(oldLogin.status).toBe(401);

			const newLogin = await call("/login", jsonBody({ username: "frank", password: "brand-new-password-1" }));
			expect(newLogin.status).toBe(200);
		});

		it("returns 404 for resetting a nonexistent account", async () => {
			const res = await call("/admin/accounts/reset", adminBody({ username: "ghost", password: "some-password-1" }));
			expect(res.status).toBe(404);
		});

		it("rejects a reset with no operator token (401), leaving the password unchanged", async () => {
			await call("/admin/accounts", adminBody({ username: "ivan", password: "original-password-1" }));

			const res = await call("/admin/accounts/reset", jsonBody({ username: "ivan", password: "attacker-reset-pw-1" }));
			expect(res.status).toBe(401);

			// the attacker's reset must NOT have taken effect — original still works, new does not
			expect((await call("/login", jsonBody({ username: "ivan", password: "attacker-reset-pw-1" }))).status).toBe(401);
			expect((await call("/login", jsonBody({ username: "ivan", password: "original-password-1" }))).status).toBe(200);
		});

		it("invalidates a session cookie issued before the reset (#81) — the incident-response gap the reset is supposed to close", async () => {
			const cookie = await createAccountAndLogin("kelly", "original-password-1");
			expect((await call("/api/navigator", { headers: { Cookie: cookie } })).status).toBe(200);

			const resetRes = await call("/admin/accounts/reset", adminBody({ username: "kelly", password: "brand-new-password-1" }));
			expect(resetRes.status).toBe(200);

			// The attacker's already-issued cookie must stop working immediately, not linger
			// for up to 24h more just because its signature and expiry are still technically valid.
			const staleRes = await call("/api/navigator", { headers: { Cookie: cookie } });
			expect(staleRes.status).toBe(401);
		});
	});

	describe("POST /admin/accounts/revoke-sessions", () => {
		it("force-logs-out a recipient without touching their password", async () => {
			const cookie = await createAccountAndLogin("liam", "a-real-password-1");
			expect((await call("/api/navigator", { headers: { Cookie: cookie } })).status).toBe(200);

			const revokeRes = await call("/admin/accounts/revoke-sessions", adminBody({ username: "liam" }));
			expect(revokeRes.status).toBe(200);

			expect((await call("/api/navigator", { headers: { Cookie: cookie } })).status).toBe(401);

			// The password itself is untouched — a fresh login still works.
			const newLogin = await call("/login", jsonBody({ username: "liam", password: "a-real-password-1" }));
			expect(newLogin.status).toBe(200);
		});

		it("returns 404 for revoking a nonexistent account", async () => {
			const res = await call("/admin/accounts/revoke-sessions", adminBody({ username: "ghost" }));
			expect(res.status).toBe(404);
		});

		it("rejects a revoke-sessions call with no operator token (401), leaving the existing session valid", async () => {
			const cookie = await createAccountAndLogin("mona", "a-real-password-1");

			const res = await call("/admin/accounts/revoke-sessions", jsonBody({ username: "mona" }));
			expect(res.status).toBe(401);

			expect((await call("/api/navigator", { headers: { Cookie: cookie } })).status).toBe(200);
		});
	});

	describe("POST /logout-everywhere (#83)", () => {
		it("invalidates every session for the caller's own account, including other devices", async () => {
			const deviceA = await createAccountAndLogin("nina", "a-real-password-1");
			const loginB = await call("/login", jsonBody({ username: "nina", password: "a-real-password-1" }));
			expect(loginB.status).toBe(200);
			const deviceB = loginB.headers.get("Set-Cookie");
			if (!deviceB) throw new Error("expected a Set-Cookie header");
			const deviceBCookie = deviceB.split(";")[0];

			const res = await call("/logout-everywhere", { method: "POST", headers: { Cookie: deviceA } });
			expect(res.status).toBe(200);

			expect((await call("/api/navigator", { headers: { Cookie: deviceA } })).status).toBe(401);
			expect((await call("/api/navigator", { headers: { Cookie: deviceBCookie } })).status).toBe(401);

			// The password itself is untouched — a fresh login still works.
			const freshLogin = await call("/login", jsonBody({ username: "nina", password: "a-real-password-1" }));
			expect(freshLogin.status).toBe(200);
		});

		it("requires a valid session (401 with no cookie)", async () => {
			const res = await call("/logout-everywhere", { method: "POST" });
			expect(res.status).toBe(401);
		});

		it("cannot be used to revoke another recipient's sessions — only the caller's own", async () => {
			const owenCookie = await createAccountAndLogin("owen", "a-real-password-1");
			const paulaCookie = await createAccountAndLogin("paula", "a-real-password-1");

			const res = await call("/logout-everywhere", { method: "POST", headers: { Cookie: owenCookie } });
			expect(res.status).toBe(200);

			expect((await call("/api/navigator", { headers: { Cookie: owenCookie } })).status).toBe(401);
			expect((await call("/api/navigator", { headers: { Cookie: paulaCookie } })).status).toBe(200);
		});

		it("rejects non-POST methods (405)", async () => {
			const cookie = await createAccountAndLogin("quinn", "a-real-password-1");
			const res = await call("/logout-everywhere", { method: "GET", headers: { Cookie: cookie } });
			expect(res.status).toBe(405);
		});
	});

	describe("hard constraint: password hashes are never plaintext or reversible", () => {
		it("the raw stored KV record never contains the plaintext password string", async () => {
			const plaintextPassword = "SuperSecretPlaintext!42";
			await call("/admin/accounts", adminBody({ username: "hank", password: plaintextPassword }));

			const raw = await ENV.NAV_CACHE.get("auth:account:hank");
			expect(raw).toBeTruthy();
			expect(raw as string).not.toContain(plaintextPassword);

			const parsed = JSON.parse(raw as string) as { passwordHash: { algorithm: string; salt: string; hash: string } };
			expect(parsed.passwordHash.algorithm).toBe("PBKDF2-HMAC-SHA256");
			expect(parsed.passwordHash.salt.length).toBeGreaterThanOrEqual(32); // 16 bytes hex-encoded
			expect(parsed.passwordHash.hash).not.toBe(plaintextPassword);
		});
	});

	describe("hard constraint: tampered/re-signed session tokens are rejected", () => {
		it("rejects a session token signed with the wrong secret", async () => {
			const { createSessionToken } = await import("./auth/session");
			const forgedToken = await createSessionToken("alice", "a-completely-different-secret");
			const res = await call("/api/navigator", { headers: { Cookie: `suxos_session=${forgedToken}` } });
			expect(res.status).toBe(401);
		});

		it("rejects a session token with a tampered username but original signature", async () => {
			const cookie = await createAccountAndLogin("ivy", "a-real-password-99");
			const token = cookie.split("=")[1];
			const [, epoch, expiresAt, signature] = token.split(".");
			const tamperedToken = `mallory.${epoch}.${expiresAt}.${signature}`;
			const res = await call("/api/navigator", { headers: { Cookie: `suxos_session=${tamperedToken}` } });
			expect(res.status).toBe(401);
		});

		it("rejects a session token for a dotted username with the original signature re-split onto a different username", async () => {
			// suxos-net#80 regression: a dotted username must round-trip through login AND
			// requireSession — this is the tampering counterpart to the plain-username case
			// above, confirming the right-to-left parse doesn't accidentally accept a
			// forged username reassembled from a dotted one's segments.
			const cookie = await createAccountAndLogin("jane.doe", "a-real-password-99");
			const token = cookie.split("=")[1];
			const [, , epoch, expiresAt, signature] = token.split(".");
			const tamperedToken = `mallory.${epoch}.${expiresAt}.${signature}`;
			const res = await call("/api/navigator", { headers: { Cookie: `suxos_session=${tamperedToken}` } });
			expect(res.status).toBe(401);
		});

		it("rejects an expired session token", async () => {
			const { createSessionToken } = await import("./auth/session");
			const longAgo = Date.now() - 1000 * 60 * 60 * 48; // 48h ago, well past the 24h expiry
			const expiredToken = await createSessionToken("alice", ENV.SESSION_SECRET, 0, longAgo);
			const res = await call("/api/navigator", { headers: { Cookie: `suxos_session=${expiredToken}` } });
			expect(res.status).toBe(401);
		});

		// suxos-net#35 HIGH: an unset SESSION_SECRET must fail CLOSED, not sign/verify
		// sessions under the well-known empty key (which would let anyone forge a cookie).
		it("refuses to SIGN a session token when SESSION_SECRET is empty", async () => {
			const { createSessionToken } = await import("./auth/session");
			await expect(createSessionToken("alice", "")).rejects.toThrow(/SESSION_SECRET/);
		});

		it("rejects (never accepts) a session token VERIFIED with an empty secret", async () => {
			const { createSessionToken, verifySessionToken } = await import("./auth/session");
			// Token legitimately signed under the real secret...
			const realToken = await createSessionToken("alice", ENV.SESSION_SECRET);
			// ...must still be rejected if the server's secret is unset (fail closed).
			expect(await verifySessionToken(realToken, "")).toBeNull();
			// And an attacker-forged empty-key token is likewise rejected.
			const emptyKeySig = "alice.9999999999999.deadbeef";
			expect(await verifySessionToken(emptyKeySig, "")).toBeNull();
		});
	});

	describe("hard constraint: no public self-serve signup route", () => {
		it("has no /signup, /register, or /api/signup route", async () => {
			for (const path of ["/signup", "/register", "/api/signup", "/api/register"]) {
				const res = await call(path, jsonBody({ username: "x", password: "y" }));
				expect(res.status).toBe(404);
			}
		});
	});
});

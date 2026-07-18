import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env } from "./index";
import { createMemoryKv } from "./test/kvMock";
import { createRateLimiterNamespace } from "./test/doMock";

let ENV: Env;

const OPERATOR_TOKEN = "test-operator-token-do-not-use-in-prod";

beforeEach(() => {
	ENV = {
		NAV_CACHE: createMemoryKv(),
		RATE_LIMITER: createRateLimiterNamespace(),
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
		// an empty per-IP counter, exactly as they depend on a fresh KV.
		return { ...ENV, NAV_CACHE: createMemoryKv(), RATE_LIMITER: createRateLimiterNamespace() };
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
			const [, expiresAt, signature] = token.split(".");
			const tamperedToken = `mallory.${expiresAt}.${signature}`;
			const res = await call("/api/navigator", { headers: { Cookie: `suxos_session=${tamperedToken}` } });
			expect(res.status).toBe(401);
		});

		it("rejects an expired session token", async () => {
			const { createSessionToken } = await import("./auth/session");
			const longAgo = Date.now() - 1000 * 60 * 60 * 48; // 48h ago, well past the 24h expiry
			const expiredToken = await createSessionToken("alice", ENV.SESSION_SECRET, longAgo);
			const res = await call("/api/navigator", { headers: { Cookie: `suxos_session=${expiredToken}` } });
			expect(res.status).toBe(401);
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

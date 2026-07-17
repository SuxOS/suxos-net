import { beforeEach, describe, expect, it } from "vitest";
import worker, { type Env } from "./index";
import { createMemoryKv } from "./test/kvMock";

let ENV: Env;

beforeEach(() => {
	ENV = {
		NAV_CACHE: createMemoryKv(),
		STAGING: "1",
		ACCESS_STAGING_IDENTITY: "dev@localhost",
		SESSION_SECRET: "test-session-secret-do-not-use-in-prod",
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

/** Extracts just the `name=value` portion of a Set-Cookie header for reuse as a request Cookie header. */
function cookieHeaderFrom(setCookie: string | null): string {
	if (!setCookie) throw new Error("expected a Set-Cookie header");
	return setCookie.split(";")[0];
}

async function createAccountAndLogin(username: string, password: string, env: Env = ENV): Promise<string> {
	const createRes = await worker.fetch(req("/admin/accounts", jsonBody({ username, password })), env);
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
		return { ...ENV, NAV_CACHE: createMemoryKv() };
	}

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
			const first = await call("/admin/accounts", jsonBody({ username: "bob", password: "operator-set-password-1" }));
			expect(first.status).toBe(201);

			const dupe = await call("/admin/accounts", jsonBody({ username: "bob", password: "some-other-password" }));
			expect(dupe.status).toBe(409);
		});

		it("rejects a password shorter than 8 characters", async () => {
			const res = await call("/admin/accounts", jsonBody({ username: "shorty", password: "short" }));
			expect(res.status).toBe(409);
		});
	});

	describe("POST /login", () => {
		it("logs in with correct credentials and sets an HttpOnly Secure SameSite=Strict cookie", async () => {
			await call("/admin/accounts", jsonBody({ username: "carol", password: "a-real-password-123" }));
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
			await call("/admin/accounts", jsonBody({ username: "dave", password: "correct-password-here" }));
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

		it("locks out after repeated failed attempts (rate limiting)", async () => {
			await call("/admin/accounts", jsonBody({ username: "erin", password: "correct-password-here" }));

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
			await call("/admin/accounts", jsonBody({ username: "frank", password: "original-password-1" }));

			const resetRes = await call("/admin/accounts/reset", jsonBody({ username: "frank", password: "brand-new-password-1" }));
			expect(resetRes.status).toBe(200);

			const oldLogin = await call("/login", jsonBody({ username: "frank", password: "original-password-1" }));
			expect(oldLogin.status).toBe(401);

			const newLogin = await call("/login", jsonBody({ username: "frank", password: "brand-new-password-1" }));
			expect(newLogin.status).toBe(200);
		});

		it("returns 404 for resetting a nonexistent account", async () => {
			const res = await call("/admin/accounts/reset", jsonBody({ username: "ghost", password: "some-password-1" }));
			expect(res.status).toBe(404);
		});
	});

	describe("hard constraint: password hashes are never plaintext or reversible", () => {
		it("the raw stored KV record never contains the plaintext password string", async () => {
			const plaintextPassword = "SuperSecretPlaintext!42";
			await call("/admin/accounts", jsonBody({ username: "hank", password: plaintextPassword }));

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

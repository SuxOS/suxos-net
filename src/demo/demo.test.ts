import { describe, expect, it } from "vitest";
import worker, { type Env } from "../index";
import { buildDemoNavigatorView } from "./demoNavigator";
import { askDemoQuestion } from "./demoQa";
import { buildDemoFlagsView } from "./demoFlags";
import { buildDemoHighlightsView } from "./demoHighlights";
import { createInMemoryKv } from "../testUtils/kv";

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

describe("buildDemoNavigatorView", () => {
	it("returns a well-shaped response with entries and the fictional-data notice", () => {
		const result = buildDemoNavigatorView("oneline", "all");
		expect(Array.isArray(result.entries)).toBe(true);
		expect(result.entries.length).toBeGreaterThanOrEqual(8);
		expect(result.notice.toLowerCase()).toContain("fictional");
		for (const entry of result.entries) {
			expect(typeof entry.id).toBe("string");
			expect(typeof entry.date).toBe("string");
			expect(typeof entry.title).toBe("string");
			expect(Array.isArray(entry.citationIds)).toBe(true);
		}
	});

	it("hides body at bare/oneline and shows it at paragraph/narrative", () => {
		expect(buildDemoNavigatorView("bare", "all").entries.every((e) => e.body === null)).toBe(true);
		expect(buildDemoNavigatorView("oneline", "all").entries.every((e) => e.body === null)).toBe(true);
		expect(buildDemoNavigatorView("paragraph", "all").entries.every((e) => typeof e.body === "string")).toBe(true);
		expect(buildDemoNavigatorView("narrative", "all").entries.every((e) => typeof e.body === "string")).toBe(true);
	});

	it("narrows entries under a smaller time scope than the full dataset span", () => {
		const all = buildDemoNavigatorView("oneline", "all");
		const week = buildDemoNavigatorView("oneline", "week");
		expect(week.entries.length).toBeLessThan(all.entries.length);
	});
});

describe("askDemoQuestion", () => {
	it("returns cited matches for a question that overlaps demo content", () => {
		const result = askDemoQuestion("What happened with Fictoprazine dosage?");
		expect(result.status).toBe("matched");
		expect(result.matches.length).toBeGreaterThan(0);
		for (const match of result.matches) {
			expect(Array.isArray(match.citations)).toBe(true);
			expect(match.citations.length).toBeGreaterThan(0);
		}
		expect(result.notice.toLowerCase()).toContain("fictional");
	});

	it("returns no_match with an empty matches array for a question with no overlap", () => {
		const result = askDemoQuestion("zzz qqq xyzzy nonsense");
		expect(result.status).toBe("no_match");
		expect(result.matches).toEqual([]);
	});
});

describe("buildDemoFlagsView", () => {
	it("finds the intentionally-conflicting demo claim pair", () => {
		const view = buildDemoFlagsView();
		const ids = new Set(view.selfConsistency.flatMap((f) => [f.claimIdA, f.claimIdB]));
		expect(ids.has("demo-claim-conflict-a")).toBe(true);
		expect(ids.has("demo-claim-conflict-b")).toBe(true);
	});

	it("finds a grounding signal for the corroborated demo claim", () => {
		const view = buildDemoFlagsView();
		expect(view.groundingSignals.some((s) => s.claimId === "demo-claim-grounded")).toBe(true);
	});

	it("finds the reference-consistency conflict against the fictional formulary reference", () => {
		const view = buildDemoFlagsView();
		expect(view.referenceConsistency.some((f) => f.claimId === "demo-claim-vs-reference")).toBe(true);
	});

	it("flags the one intentionally-dangling citation and nothing else", () => {
		const view = buildDemoFlagsView();
		expect(view.citationIntegrity.clean).toBe(false);
		expect(view.citationIntegrity.dangling).toEqual([
			{ recordId: "demo-claim-conflict-b", citationId: "demo-cite-012" },
		]);
	});
});

const FORBIDDEN_HIGHLIGHT_WORDS = ["wrong", "false", "verified", "lying", "lied", "incorrect"];

describe("buildDemoHighlightsView", () => {
	it("returns hedged highlights with confidence scores, never forbidden assertive language", () => {
		const view = buildDemoHighlightsView();
		expect(view.highlights.length).toBeGreaterThan(0);
		expect(view.notice.toLowerCase()).toContain("fictional");
		for (const highlight of view.highlights) {
			expect(highlight.confidence).toBeLessThan(1);
			const lower = highlight.note.toLowerCase();
			for (const forbidden of FORBIDDEN_HIGHLIGHT_WORDS) {
				expect(lower).not.toContain(forbidden);
			}
		}
	});

	it("flags the strongly-worded testimony document with a tone highlight", () => {
		const view = buildDemoHighlightsView();
		const toneHighlight = view.highlights.find(
			(h): h is Extract<typeof h, { type: "tone" }> => h.type === "tone" && h.sourceId === "demo-testimony-001",
		);
		expect(toneHighlight).toBeDefined();
	});

	it("never emits a possible-inconsistency highlight for a testimony document", () => {
		const view = buildDemoHighlightsView();
		const testimonyIds = new Set(["demo-testimony-001", "demo-testimony-002"]);
		const testimonyInconsistencies = view.highlights.filter(
			(h) => h.type === "possible-inconsistency" && testimonyIds.has(h.sourceId),
		);
		expect(testimonyInconsistencies).toEqual([]);
	});

	it("finds the intentionally-conflicting demo claim pair as a possible-inconsistency highlight", () => {
		const view = buildDemoHighlightsView();
		const ids = new Set(
			view.highlights.filter((h) => h.type === "possible-inconsistency").map((h) => h.sourceId),
		);
		expect(ids.has("demo-claim-conflict-a") || ids.has("demo-claim-conflict-b")).toBe(true);
	});
});

describe("GET /demo/highlights", () => {
	it("returns 200 with hedged highlights", async () => {
		const res = await call("/demo/highlights");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { highlights: unknown[]; notice: string };
		expect(Array.isArray(body.highlights)).toBe(true);
		expect(body.highlights.length).toBeGreaterThan(0);
		expect(body.notice.toLowerCase()).toContain("fictional");
	});

	it("returns 405 with Allow: GET for a non-GET method", async () => {
		const res = await call("/demo/highlights", { method: "POST" });
		expect(res.status).toBe(405);
		expect(res.headers.get("Allow")).toBe("GET");
	});
});

describe("GET /demo/navigator", () => {
	it("returns 200 with fictional entries", async () => {
		const res = await call("/demo/navigator?verbosity=oneline&timeScope=all");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { entries: unknown[]; notice: string };
		expect(body.entries.length).toBeGreaterThan(0);
		expect(body.notice.toLowerCase()).toContain("fictional");
	});

	it("returns a structured 400 for an invalid verbosity, same as /api/navigator", async () => {
		const res = await call("/demo/navigator?verbosity=essay");
		expect(res.status).toBe(400);
	});

	it("returns 405 with Allow: GET for a non-GET method", async () => {
		const res = await call("/demo/navigator", { method: "POST" });
		expect(res.status).toBe(405);
		expect(res.headers.get("Allow")).toBe("GET");
	});
});

describe("POST /demo/qa", () => {
	it("returns 200 with cited matches for a real question", async () => {
		const res = await call("/demo/qa", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ question: "Tell me about the fictional wellness visit" }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { matches: unknown[] };
		expect(Array.isArray(body.matches)).toBe(true);
	});

	it("returns a structured 400 for a missing question, same contract as /api/qa", async () => {
		const res = await call("/demo/qa", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
	});
});

describe("GET /demo/flags", () => {
	it("returns 200 with self-consistency, grounding, reference, and citation-integrity results", async () => {
		const res = await call("/demo/flags");
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			selfConsistency: unknown[];
			groundingSignals: unknown[];
			referenceConsistency: unknown[];
			citationIntegrity: { clean: boolean };
		};
		expect(body.selfConsistency.length).toBeGreaterThan(0);
		expect(body.groundingSignals.length).toBeGreaterThan(0);
		expect(body.referenceConsistency.length).toBeGreaterThan(0);
		expect(body.citationIntegrity.clean).toBe(false);
	});
});

describe("existing /api/* routes are unchanged", () => {
	it("/api/qa still returns the not_implemented stub shape", async () => {
		const res = await call("/api/qa", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ question: "anything" }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { status: string; citations: unknown[] };
		expect(body.status).toBe("not_implemented");
		expect(body.citations).toEqual([]);
	});
});

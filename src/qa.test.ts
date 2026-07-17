import { describe, expect, it, vi } from "vitest";
import { askQuestion, type QaEnv } from "./qa";

function makeAi(opts: { embedding?: number[]; llmResponse?: string | null } = {}): { ai: Ai; run: ReturnType<typeof vi.fn> } {
	const embedding = opts.embedding ?? [1, 0, 0];
	const run = vi.fn(async (model: string, inputs: unknown) => {
		if (model.includes("bge")) {
			const texts = Array.isArray((inputs as { text: unknown }).text)
				? (inputs as { text: string[] }).text
				: [(inputs as { text: string }).text];
			return { data: texts.map(() => embedding) };
		}
		return { response: opts.llmResponse ?? "The record says X (Passage 1)." };
	});
	return { ai: { run } as unknown as Ai, run };
}

function makeIndex(matches: { score: number; metadata?: Record<string, unknown> }[]): { index: Vectorize; query: ReturnType<typeof vi.fn> } {
	const query = vi.fn(async () => ({ matches, count: matches.length }));
	return { index: { query } as unknown as Vectorize, query };
}

describe("askQuestion", () => {
	it("returns a synthesized, cited, hedged answer when retrieval clears the threshold", async () => {
		const { ai, run } = makeAi();
		const { index } = makeIndex([
			{ score: 0.9, metadata: { sourcePath: "records/a.md", heading: "Section", text: "content about a" } },
		]);
		const env: QaEnv = { AI: ai, VECTORIZE_INDEX: index };

		const result = await askQuestion("What happened with a?", env);

		expect(result.status).toBe("answered");
		expect(result.citations).toEqual([{ sourcePath: "records/a.md", heading: "Section", score: 0.9 }]);
		expect(result.confidence).not.toBeNull();
		expect(result.confidence).toBeLessThan(1);
		expect(result.answer).toContain("appears to say");
		expect(result.answer).not.toMatch(/\btrue\b|\bverified\b|\bwrong\b/i);

		// Two AI calls: one embedding call, one LLM call.
		expect(run).toHaveBeenCalledTimes(2);
	});

	it("does NOT call the LLM when nothing clears the similarity threshold (hard constraint)", async () => {
		const { ai, run } = makeAi();
		const { index } = makeIndex([{ score: 0.4, metadata: { sourcePath: "records/unrelated.md", text: "unrelated" } }]);
		const env: QaEnv = { AI: ai, VECTORIZE_INDEX: index };

		const result = await askQuestion("Something out of scope", env);

		expect(result.status).toBe("no_match");
		expect(result.citations).toEqual([]);
		expect(result.confidence).toBeNull();

		// Only the embedding call should have fired — never the LLM.
		expect(run).toHaveBeenCalledTimes(1);
		const modelsCalled = run.mock.calls.map((call) => call[0]);
		expect(modelsCalled.every((m) => String(m).includes("bge"))).toBe(true);
	});

	it("does NOT call the LLM when Vectorize returns no matches at all", async () => {
		const { ai, run } = makeAi();
		const { index } = makeIndex([]);
		const env: QaEnv = { AI: ai, VECTORIZE_INDEX: index };

		await askQuestion("Anything?", env);
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("returns the honest not-found path for a question adjacent to but not covered by indexed content (no fabrication)", async () => {
		// Simulates a question that's topically nearby (so Vectorize returns *some*
		// matches) but not actually covered by anything indexed — all matches land
		// below the similarity threshold.
		const { ai, run } = makeAi();
		const { index } = makeIndex([
			{ score: 0.55, metadata: { sourcePath: "records/adjacent-topic.md", text: "a loosely related note" } },
			{ score: 0.5, metadata: { sourcePath: "records/other.md", text: "another loosely related note" } },
		]);
		const env: QaEnv = { AI: ai, VECTORIZE_INDEX: index };

		const result = await askQuestion("A question adjacent to, but not answered by, the indexed content", env);

		expect(result.status).toBe("no_match");
		expect(result.answer).not.toContain("appears to say");
		expect(result.citations).toEqual([]);
		expect(run).toHaveBeenCalledTimes(1);
	});

	it("builds an LLM context containing only the retrieved chunk text and source labels, nothing else", async () => {
		const { ai, run } = makeAi();
		const { index } = makeIndex([
			{ score: 0.9, metadata: { sourcePath: "records/secret.md", heading: "H", text: "UNIQUE_MARKER_TEXT_12345" } },
		]);
		const env: QaEnv = { AI: ai, VECTORIZE_INDEX: index };

		await askQuestion("What is the marker?", env);

		const llmCall = run.mock.calls.find((call) => !String(call[0]).includes("bge"));
		expect(llmCall).toBeDefined();
		const messages = (llmCall![1] as { messages: { content: string }[] }).messages;
		const context = messages.map((m) => m.content).join("\n");
		expect(context).toContain("UNIQUE_MARKER_TEXT_12345");
		expect(context).toContain("records/secret.md");
		// No mention of anything outside the passages/question framing.
		expect(context.split("UNIQUE_MARKER_TEXT_12345").length - 1).toBe(1);
	});

	it("falls back to no_match if the LLM returns an empty response", async () => {
		const { ai, run } = makeAi({ llmResponse: "" });
		const { index } = makeIndex([{ score: 0.9, metadata: { sourcePath: "records/a.md", text: "content" } }]);
		const env: QaEnv = { AI: ai, VECTORIZE_INDEX: index };

		const result = await askQuestion("Question", env);
		expect(result.status).toBe("no_match");
		void run;
	});

	it("falls back to no_match if a matched vector is missing its source path metadata", async () => {
		const { ai } = makeAi();
		const { index } = makeIndex([{ score: 0.9, metadata: { text: "content with no source" } }]);
		const env: QaEnv = { AI: ai, VECTORIZE_INDEX: index };

		const result = await askQuestion("Question", env);
		expect(result.status).toBe("no_match");
		expect(result.citations).toEqual([]);
	});

	it("echoes back the question text unchanged", async () => {
		const { ai } = makeAi();
		const { index } = makeIndex([]);
		const env: QaEnv = { AI: ai, VECTORIZE_INDEX: index };

		const result = await askQuestion("What happened in March?", env);
		expect(result.question).toBe("What happened in March?");
	});
});

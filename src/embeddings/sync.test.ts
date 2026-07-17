import { describe, expect, it, vi } from "vitest";
import { syncVaultEmbeddings } from "./sync";

function base64(text: string): string {
	return btoa(String.fromCharCode(...new TextEncoder().encode(text)));
}

/** Minimal fake GitHub API: one tree listing + per-path content responses. */
function makeGithubFetch(files: Record<string, string>): typeof fetch {
	const paths = Object.keys(files);
	return vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.includes("/git/trees/")) {
			return new Response(
				JSON.stringify({ tree: paths.map((path) => ({ path, type: "blob" })), truncated: false }),
				{ status: 200 },
			);
		}
		const match = paths.find((path) => url.includes(encodeURI(path)));
		if (!match) return new Response("not found", { status: 404 });
		return new Response(JSON.stringify({ content: base64(files[match]), encoding: "base64" }), { status: 200 });
	}) as unknown as typeof fetch;
}

function makeMockAi(): Ai {
	return {
		run: vi.fn(async (_model: unknown, inputs: { text: string | string[] }) => {
			const texts = Array.isArray(inputs.text) ? inputs.text : [inputs.text];
			return { data: texts.map((t) => [t.length, 0, 0]) };
		}),
	} as unknown as Ai;
}

function makeMockIndex(): { index: Vectorize; upserted: VectorizeVector[][] } {
	const upserted: VectorizeVector[][] = [];
	const index = {
		upsert: vi.fn(async (vectors: VectorizeVector[]) => {
			upserted.push(vectors);
			return { mutationId: "mock" };
		}),
	} as unknown as Vectorize;
	return { index, upserted };
}

const NOTE_A = `---\ntitle: A\n---\n\n## Section 1\nContent one.\n\n## Section 2\nContent two.\n`;
const NOTE_B = `---\ntitle: B\n---\n\nJust one plain section, no headings.\n`;

describe("syncVaultEmbeddings", () => {
	it("chunks, embeds, and upserts every markdown file with resolvable source metadata", async () => {
		const files = { "records/a.md": NOTE_A, "records/b.md": NOTE_B };
		const fetchImpl = makeGithubFetch(files);
		const ai = makeMockAi();
		const { index, upserted } = makeMockIndex();

		const result = await syncVaultEmbeddings(ai, index, "fake-token", fetchImpl);

		expect(result.filesScanned).toBe(2);
		expect(result.chunksEmbedded).toBeGreaterThan(0);
		expect(result.vectorsUpserted).toBe(result.chunksEmbedded);

		const allVectors = upserted.flat();
		expect(allVectors.length).toBe(result.vectorsUpserted);
		for (const vector of allVectors) {
			const sourcePath = vector.metadata?.sourcePath;
			expect(typeof sourcePath).toBe("string");
			expect(sourcePath).toBeTruthy();
			expect(Object.keys(files)).toContain(sourcePath);
			expect(typeof vector.id).toBe("string");
			expect(vector.id.length).toBeGreaterThan(0);
		}
	});

	it("re-running sync against unchanged content upserts the same vector ids (no duplication)", async () => {
		const files = { "records/a.md": NOTE_A };
		const ai = makeMockAi();
		const { index, upserted } = makeMockIndex();

		await syncVaultEmbeddings(ai, index, "fake-token", makeGithubFetch(files));
		const firstIds = upserted.flat().map((v) => v.id);

		await syncVaultEmbeddings(ai, index, "fake-token", makeGithubFetch(files));
		const secondIds = upserted.flat().slice(firstIds.length).map((v) => v.id);

		expect(secondIds).toEqual(firstIds);
		expect(new Set([...firstIds, ...secondIds]).size).toBe(firstIds.length);
	});

	it("produces different vector ids for different notes and different chunks within a note", async () => {
		const files = { "records/a.md": NOTE_A, "records/b.md": NOTE_B };
		const ai = makeMockAi();
		const { index, upserted } = makeMockIndex();

		await syncVaultEmbeddings(ai, index, "fake-token", makeGithubFetch(files));
		const ids = upserted.flat().map((v) => v.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("throws instead of silently truncating when the GitHub tree listing is truncated", async () => {
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ tree: [], truncated: true }), { status: 200 }));
		const ai = makeMockAi();
		const { index } = makeMockIndex();

		await expect(syncVaultEmbeddings(ai, index, "fake-token", fetchImpl as unknown as typeof fetch)).rejects.toThrow(
			/truncated/,
		);
	});
});

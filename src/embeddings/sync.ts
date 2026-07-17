// Real (non-stub) embedding pipeline over suxvault's markdown notes — issue #30 /
// design doc §2. Fetches current note content from GitHub, chunks it (chunk.ts),
// embeds each chunk with the shared Workers AI model (embed.ts), and upserts into the
// `suxvault-notes` Vectorize index with a stable, path-derived vector id (vectorId.ts)
// so re-running this against unchanged content updates the same vectors instead of
// duplicating them.
//
// Hard constraint (design doc, non-negotiable): every vector must carry a real,
// resolvable source path in its metadata. This module never upserts a vector without
// one — chunkMarkdown always attaches sourcePath, and buildVectorRecords asserts it's
// non-empty before including a record.

import { chunkMarkdown } from "./chunk";
import { embedTexts } from "./embed";
import { vectorIdFor } from "./vectorId";

const VAULT_OWNER = "SuxOS";
const VAULT_REPO = "suxvault";
const VAULT_REF = "main";

export interface EmbeddingSyncResult {
	filesScanned: number;
	chunksEmbedded: number;
	vectorsUpserted: number;
}

interface GithubTreeResponse {
	tree: { path: string; type: string }[];
	truncated?: boolean;
}

interface GithubContentResponse {
	content: string;
	encoding: string;
}

function githubHeaders(githubToken: string): HeadersInit {
	return {
		Authorization: `token ${githubToken}`,
		Accept: "application/vnd.github+json",
		"User-Agent": "suxos-net-embedding-sync",
	};
}

async function listMarkdownPaths(githubToken: string, fetchImpl: typeof fetch): Promise<string[]> {
	const url = `https://api.github.com/repos/${VAULT_OWNER}/${VAULT_REPO}/git/trees/${VAULT_REF}?recursive=1`;
	const res = await fetchImpl(url, { headers: githubHeaders(githubToken) });
	if (!res.ok) throw new Error(`GitHub tree fetch failed for ${VAULT_OWNER}/${VAULT_REPO}@${VAULT_REF}: ${res.status}`);
	const body = (await res.json()) as GithubTreeResponse;
	if (body.truncated) {
		throw new Error("GitHub tree listing was truncated; suxvault is too large for a single recursive tree call");
	}
	return body.tree.filter((entry) => entry.type === "blob" && entry.path.endsWith(".md")).map((entry) => entry.path);
}

async function fetchMarkdownContent(path: string, githubToken: string, fetchImpl: typeof fetch): Promise<string> {
	const url = `https://api.github.com/repos/${VAULT_OWNER}/${VAULT_REPO}/contents/${encodeURI(path)}?ref=${VAULT_REF}`;
	const res = await fetchImpl(url, { headers: githubHeaders(githubToken) });
	if (!res.ok) throw new Error(`GitHub content fetch failed for ${path}: ${res.status}`);
	const body = (await res.json()) as GithubContentResponse;
	if (body.encoding !== "base64") throw new Error(`unexpected encoding "${body.encoding}" for ${path}`);
	// atob is available in the Workers runtime; content may contain embedded newlines.
	const binary = atob(body.content.replace(/\n/g, ""));
	const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
	return new TextDecoder().decode(bytes);
}

/**
 * Re-embed every markdown note in suxvault and upsert the resulting chunk vectors
 * into the given Vectorize index. Idempotent: vector ids are derived from
 * (sourcePath, chunkIndex), not content, so re-running against unchanged notes
 * upserts identical ids in place rather than creating duplicates.
 */
export async function syncVaultEmbeddings(
	ai: Ai,
	index: Vectorize,
	githubToken: string,
	fetchImpl: typeof fetch = fetch,
): Promise<EmbeddingSyncResult> {
	const paths = await listMarkdownPaths(githubToken, fetchImpl);

	let chunksEmbedded = 0;
	let vectorsUpserted = 0;

	for (const path of paths) {
		const content = await fetchMarkdownContent(path, githubToken, fetchImpl);
		const chunks = chunkMarkdown(path, content);
		if (chunks.length === 0) continue;

		const vectors = await embedTexts(
			ai,
			chunks.map((c) => c.text),
		);
		if (vectors.length !== chunks.length) {
			throw new Error(`embedding count mismatch for ${path}: ${vectors.length} vectors for ${chunks.length} chunks`);
		}

		const records: VectorizeVector[] = [];
		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i];
			if (!chunk.sourcePath) {
				// Hard constraint: never upsert a vector without a resolvable source path.
				throw new Error(`refusing to embed a chunk with no sourcePath (index ${i} of ${path})`);
			}
			records.push({
				id: await vectorIdFor(chunk.sourcePath, chunk.chunkIndex),
				values: vectors[i],
				metadata: {
					sourcePath: chunk.sourcePath,
					heading: chunk.heading ?? "",
					chunkIndex: chunk.chunkIndex,
					text: chunk.text,
				},
			});
		}

		await index.upsert(records);
		chunksEmbedded += chunks.length;
		vectorsUpserted += records.length;
	}

	return { filesScanned: paths.length, chunksEmbedded, vectorsUpserted };
}

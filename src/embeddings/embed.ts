// Shared Workers AI embedding helper used by both the indexing pipeline
// (src/embeddings/sync.ts) and the QA endpoint (src/qa.ts), so both sides of the
// retrieval loop always embed with the exact same model — a mismatch here would
// silently break cosine similarity (see design doc §2/§3).

export const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5" as const;

/** Workers AI's per-call batch ceiling for this model; keep call sizes under it. */
const EMBED_BATCH_SIZE = 90;

function chunkArray<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

/**
 * Embed a batch of texts with the shared embedding model, preserving input order.
 * Splits into sub-batches under Workers AI's per-call limit; throws if the model
 * doesn't return one vector per input (fail loud rather than silently misalign
 * chunk metadata with the wrong vector).
 */
export async function embedTexts(ai: Ai, texts: string[]): Promise<number[][]> {
	if (texts.length === 0) return [];

	const batches = chunkArray(texts, EMBED_BATCH_SIZE);
	const results: number[][] = [];

	for (const batch of batches) {
		const output = await ai.run(EMBEDDING_MODEL, { text: batch });
		const data = (output as { data?: number[][] }).data;
		if (!data || data.length !== batch.length) {
			throw new Error(
				`embedding model returned ${data?.length ?? 0} vectors for a batch of ${batch.length} texts`,
			);
		}
		results.push(...data);
	}

	return results;
}

/** Embed a single text (e.g. an incoming QA question) and return its vector. */
export async function embedText(ai: Ai, text: string): Promise<number[]> {
	const [vector] = await embedTexts(ai, [text]);
	return vector;
}

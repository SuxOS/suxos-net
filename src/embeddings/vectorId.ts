// Stable vector-id derivation: id = f(sourcePath, chunkIndex), NOT f(text content).
// That's what makes re-sync idempotent — re-running against unchanged content upserts
// the same ids (Vectorize.upsert replaces in place), and re-running against *edited*
// content still targets the same chunk slot rather than leaving an orphaned old vector
// behind, as long as the note's heading structure at that index is stable. A pure
// content hash would defeat this (every edit would mint a new id and never clean up
// the old one), so identity here is deliberately path+index, not content.

/** SHA-256 of `input`, hex-encoded, truncated to `length` hex chars. */
async function shortHash(input: string, length: number): Promise<string> {
	const bytes = new TextEncoder().encode(input);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
	return hex.slice(0, length);
}

/**
 * Derive the Vectorize vector id for a given chunk. Deterministic and stable across
 * re-syncs: same (sourcePath, chunkIndex) always yields the same id.
 */
export async function vectorIdFor(sourcePath: string, chunkIndex: number): Promise<string> {
	const pathHash = await shortHash(sourcePath, 24);
	return `c_${pathHash}_${chunkIndex}`;
}

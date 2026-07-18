// Shared loader for /demo/flags and /demo/highlights (#65): both need the same
// curated-store-with-fictional-fallback behavior, so it lives in one place rather than
// being duplicated across demoFlags.ts and demoHighlights.ts.

import { listReferences, toTrustedReference } from "../references/store";
import { demoTrustedReferences } from "./demoData";
import type { TrustedReference } from "../tools/inconsistencyFlagger";

/**
 * Reads curated references from the real KV-backed store (src/references/store.ts,
 * #19) so that adding/editing/removing a reference via /admin/references becomes
 * visible in the demo. Falls back to the fictional demoTrustedReferences array only
 * when the store is empty, so a fresh deploy with no curated content isn't blank.
 */
export async function loadDemoTrustedReferences(kv: KVNamespace): Promise<TrustedReference[]> {
	const { references } = await listReferences(kv);
	if (references.length === 0) return demoTrustedReferences;
	return references.map(toTrustedReference);
}

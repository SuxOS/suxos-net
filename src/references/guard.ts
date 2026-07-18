/**
 * Runtime enforcement point for trusted-reference sourcing (#19). This module is the
 * ONLY sanctioned way for a reference-consistency check (or any future flagger) to
 * obtain trusted references — every reference it returns comes exclusively from the
 * KV-backed curated store (src/references/store.ts), which in turn is written to only
 * by the operator-only admin CRUD routes (src/references/routes.ts).
 *
 * This is deliberately NOT wired to any LLM client, external API, or general/open
 * knowledge lookup — in this Worker the only primitive that could reach such a source
 * at runtime is `fetch`, and neither this function nor anything it calls invokes it.
 * See guard.test.ts, which asserts exactly that with a `fetch` spy.
 */

import { flagAgainstReferences, type Claim, type ReferenceInconsistencyFlag, type TrustedReference } from "../tools/inconsistencyFlagger";
import { listReferences, type CuratedReference } from "./store";

function toTrustedReference(curated: CuratedReference): TrustedReference {
	return { id: curated.id, text: curated.fact, source: curated.source, sourceUrl: curated.sourceUrl };
}

/**
 * The full curated trusted-reference set, mapped into the shape
 * {@link flagAgainstReferences} expects. Reads exclusively from `kv` — no other
 * argument, no network access, no fallback source.
 */
export async function getCuratedTrustedReferences(kv: KVNamespace): Promise<TrustedReference[]> {
	const curated = await listReferences(kv);
	return curated.map(toTrustedReference);
}

/**
 * Runs the reference-consistency check against ONLY the curated store — the sole
 * entry point a caller should use instead of calling {@link flagAgainstReferences}
 * directly with a hand-assembled reference list.
 */
export async function checkClaimsAgainstCuratedReferences(kv: KVNamespace, claims: Claim[]): Promise<ReferenceInconsistencyFlag[]> {
	const references = await getCuratedTrustedReferences(kv);
	return flagAgainstReferences(claims, references);
}

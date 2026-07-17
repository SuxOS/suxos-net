// Human-curated trusted-reference store: schema + admin CRUD + a runtime guard that
// enforces every reference reaching inconsistencyFlagger.ts's flagAgainstReferences
// carries curation provenance. Design principle this exists to enforce: trusted
// references are EXPLICITLY human-curated only, never pulled from open/general
// knowledge at runtime (see the TSDoc on TrustedReference in inconsistencyFlagger.ts).

import type { TrustedReference } from "./inconsistencyFlagger";

export interface CuratedReferenceInput {
	fact: string;
	source: string;
	sourceUrl?: string;
	curator: string;
	scopeOfApplicability: string[];
}

export interface CuratedReference extends CuratedReferenceInput {
	id: string;
	dateAdded: string;
}

function validateInput(input: CuratedReferenceInput): void {
	if (input.fact.trim().length === 0) throw new Error("fact must not be empty");
	if (input.source.trim().length === 0) throw new Error("source must not be empty");
	if (input.curator.trim().length === 0) throw new Error("curator must not be empty");
	if (input.scopeOfApplicability.length === 0) throw new Error("scopeOfApplicability must have at least one entry");
}

export interface TrustedReferenceStore {
	add(input: CuratedReferenceInput, now: string): CuratedReference;
	update(id: string, patch: Partial<CuratedReferenceInput>, now: string): CuratedReference;
	remove(id: string): void;
	list(): CuratedReference[];
	get(id: string): CuratedReference | undefined;
}

/**
 * Single-curator admin CRUD store for trusted references, in-memory per this
 * codebase's existing "pure store, no external I/O" pattern (see src/tools/*.ts).
 * `dateAdded` is stamped fresh on both add and update, so it always reflects the most
 * recent human curation action on that entry.
 */
export function createTrustedReferenceStore(): TrustedReferenceStore {
	const references = new Map<string, CuratedReference>();
	let nextId = 1;

	return {
		add(input, now) {
			validateInput(input);
			const reference: CuratedReference = { id: `ref-${nextId++}`, dateAdded: now, ...input };
			references.set(reference.id, reference);
			return reference;
		},
		update(id, patch, now) {
			const existing = references.get(id);
			if (!existing) throw new Error(`unknown reference: ${id}`);
			const updated: CuratedReference = { ...existing, ...patch, id: existing.id, dateAdded: now };
			validateInput(updated);
			references.set(id, updated);
			return updated;
		},
		remove(id) {
			if (!references.delete(id)) throw new Error(`unknown reference: ${id}`);
		},
		list() {
			return [...references.values()];
		},
		get(id) {
			return references.get(id);
		},
	};
}

/**
 * Runtime guard: fails closed unless `candidate` carries curation provenance (a
 * non-empty `curator` and `dateAdded`). This is the enforcement point the design
 * principle requires — anything shaped like a `TrustedReference` but missing curation
 * metadata (e.g. a hypothetical runtime LLM/open-knowledge lookup result masquerading
 * as a reference) is rejected here, before it can reach flagAgainstReferences.
 */
export function assertCuratedProvenance(candidate: unknown): asserts candidate is CuratedReference {
	if (typeof candidate !== "object" || candidate === null) {
		throw new Error("trusted reference must be an object");
	}
	const record = candidate as Record<string, unknown>;
	if (typeof record.curator !== "string" || record.curator.trim().length === 0) {
		throw new Error(
			"trusted reference is missing curator provenance — refusing a non-curated (e.g. open-knowledge) reference",
		);
	}
	if (typeof record.dateAdded !== "string" || record.dateAdded.trim().length === 0) {
		throw new Error(
			"trusted reference is missing dateAdded provenance — refusing a non-curated (e.g. open-knowledge) reference",
		);
	}
}

/**
 * The only sanctioned way to obtain a `TrustedReference[]` for
 * inconsistencyFlagger.ts's flagAgainstReferences from a curated store: every entry is
 * re-validated for curation provenance immediately before adapting it, so a caller can
 * never accidentally feed flagAgainstReferences anything but human-curated references.
 */
export function toTrustedReferences(store: TrustedReferenceStore): TrustedReference[] {
	return store.list().map((reference) => {
		assertCuratedProvenance(reference);
		return { id: reference.id, text: reference.fact, source: reference.source, sourceUrl: reference.sourceUrl };
	});
}

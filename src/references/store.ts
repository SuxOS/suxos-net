/**
 * Durable storage for trusted references (#19) — KV-backed, same NAV_CACHE namespace
 * as accounts (src/auth/store.ts), distinct key prefix. Design principle this store
 * exists to enforce: trusted references (external facts like drug interactions, legal
 * standards) are EXPLICITLY human-curated only, and must never be pulled from open/
 * general knowledge at runtime. Every record here is written ONLY via the
 * operator-only admin CRUD routes (src/references/routes.ts) — there is no self-serve
 * or LLM-populated write path. See src/references/guard.ts for the runtime read-side
 * enforcement point.
 */

const REFERENCE_KEY_PREFIX = "reference:trusted:";
const REFERENCE_INDEX_KEY = "reference:trusted:index";

/**
 * A single, explicitly human-curated trusted reference. Schema per #19: the fact
 * being asserted, the source it was curated from, who curated it, when, and the
 * scope it applies to (so a reader knows when this reference is/isn't relevant).
 */
export interface CuratedReference {
	id: string;
	fact: string;
	source: string;
	sourceUrl?: string;
	curator: string;
	/** ISO-8601 timestamp, always server-set — never client-supplied (see createReference). */
	dateAdded: string;
	scopeOfApplicability: string;
}

function referenceKey(id: string): string {
	return REFERENCE_KEY_PREFIX + id;
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

async function readIndex(kv: KVNamespace): Promise<string[]> {
	const raw = await kv.get(REFERENCE_INDEX_KEY);
	if (!raw) return [];
	return JSON.parse(raw) as string[];
}

async function writeIndex(kv: KVNamespace, ids: string[]): Promise<void> {
	await kv.put(REFERENCE_INDEX_KEY, JSON.stringify(ids));
}

export async function getReference(kv: KVNamespace, id: string): Promise<CuratedReference | null> {
	const raw = await kv.get(referenceKey(id));
	if (!raw) return null;
	return JSON.parse(raw) as CuratedReference;
}

/**
 * Every curated reference, in insertion order. This — and ONLY this — is the
 * sanctioned way to enumerate the curated set; see src/references/guard.ts, which is
 * the sole caller a reference-consistency check should ever go through.
 */
export async function listReferences(kv: KVNamespace): Promise<CuratedReference[]> {
	const ids = await readIndex(kv);
	const records = await Promise.all(ids.map((id) => getReference(kv, id)));
	return records.filter((record): record is CuratedReference => record !== null);
}

export interface CreateReferenceInput {
	fact: string;
	source: string;
	sourceUrl?: string;
	curator: string;
	scopeOfApplicability: string;
}

export type CreateReferenceResult = { ok: true; reference: CuratedReference } | { ok: false; error: string };

function validateCreateInput(input: CreateReferenceInput): string | null {
	if (!nonEmptyString(input.fact)) return "fact must be a non-empty string";
	if (!nonEmptyString(input.source)) return "source must be a non-empty string";
	if (!nonEmptyString(input.curator)) return "curator must be a non-empty string";
	if (!nonEmptyString(input.scopeOfApplicability)) return "scopeOfApplicability must be a non-empty string";
	if (input.sourceUrl !== undefined && typeof input.sourceUrl !== "string") return "sourceUrl must be a string when present";
	return null;
}

/**
 * Operator-only: adds one explicitly human-curated reference. `dateAdded` is always
 * set server-side to the current time — never trusted from the caller — so the
 * curation timestamp can't be backdated or forged.
 */
export async function createReference(kv: KVNamespace, input: CreateReferenceInput): Promise<CreateReferenceResult> {
	const validationError = validateCreateInput(input);
	if (validationError) return { ok: false, error: validationError };

	const reference: CuratedReference = {
		id: crypto.randomUUID(),
		fact: input.fact.trim(),
		source: input.source.trim(),
		sourceUrl: input.sourceUrl?.trim() || undefined,
		curator: input.curator.trim(),
		dateAdded: new Date().toISOString(),
		scopeOfApplicability: input.scopeOfApplicability.trim(),
	};

	await kv.put(referenceKey(reference.id), JSON.stringify(reference));
	const ids = await readIndex(kv);
	ids.push(reference.id);
	await writeIndex(kv, ids);

	return { ok: true, reference };
}

export interface UpdateReferenceInput {
	fact?: string;
	source?: string;
	sourceUrl?: string;
	curator?: string;
	scopeOfApplicability?: string;
}

export type UpdateReferenceResult = { ok: true; reference: CuratedReference } | { ok: false; error: string };

/**
 * Operator-only: edits an existing curated reference in place. `id` and `dateAdded`
 * are immutable — dateAdded records when the reference was originally curated, not
 * when it was last touched.
 */
export async function updateReference(kv: KVNamespace, id: string, patch: UpdateReferenceInput): Promise<UpdateReferenceResult> {
	const existing = await getReference(kv, id);
	if (!existing) return { ok: false, error: "reference not found" };

	if (patch.fact !== undefined && !nonEmptyString(patch.fact)) return { ok: false, error: "fact must be a non-empty string" };
	if (patch.source !== undefined && !nonEmptyString(patch.source)) return { ok: false, error: "source must be a non-empty string" };
	if (patch.curator !== undefined && !nonEmptyString(patch.curator)) return { ok: false, error: "curator must be a non-empty string" };
	if (patch.scopeOfApplicability !== undefined && !nonEmptyString(patch.scopeOfApplicability)) {
		return { ok: false, error: "scopeOfApplicability must be a non-empty string" };
	}
	if (patch.sourceUrl !== undefined && typeof patch.sourceUrl !== "string") return { ok: false, error: "sourceUrl must be a string when present" };

	const updated: CuratedReference = {
		...existing,
		fact: patch.fact !== undefined ? patch.fact.trim() : existing.fact,
		source: patch.source !== undefined ? patch.source.trim() : existing.source,
		sourceUrl: patch.sourceUrl !== undefined ? patch.sourceUrl.trim() || undefined : existing.sourceUrl,
		curator: patch.curator !== undefined ? patch.curator.trim() : existing.curator,
		scopeOfApplicability: patch.scopeOfApplicability !== undefined ? patch.scopeOfApplicability.trim() : existing.scopeOfApplicability,
	};

	await kv.put(referenceKey(id), JSON.stringify(updated));
	return { ok: true, reference: updated };
}

export type DeleteReferenceResult = { ok: true } | { ok: false; error: string };

/** Operator-only: removes a curated reference. */
export async function deleteReference(kv: KVNamespace, id: string): Promise<DeleteReferenceResult> {
	const existing = await getReference(kv, id);
	if (!existing) return { ok: false, error: "reference not found" };

	await kv.delete(referenceKey(id));
	const ids = await readIndex(kv);
	await writeIndex(kv, ids.filter((existingId) => existingId !== id));
	return { ok: true };
}

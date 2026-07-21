/**
 * Durable storage for curated trusted references (#19) — same KV-with-key-prefix
 * pattern as src/auth/store.ts and src/audit/log.ts (reuses NAV_CACHE rather than
 * provisioning a dedicated namespace; see src/auth/store.ts's header for why).
 *
 * Design principle (docs/superpowers/specs/2026-07-17-real-access-and-retrieval-design.md
 * §6): trusted references are EXPLICITLY human-curated only and must never be pulled
 * from open/general knowledge at runtime. This module is the ONLY place a
 * CuratedReference is ever written — every write goes through `createReference`/
 * `updateReference`/`deleteReference`, called only from the operator-only admin routes
 * in src/references/routes.ts. `listReferences` is the ONLY function the review
 * pipeline (src/review.ts) may use to source `TrustedReference[]` for
 * `flagAgainstReferences` — see the runtime guard there. Single-curator is fine for
 * now (#19 scope): `curator` is a free-text field, not tied to a per-curator login.
 *
 * createReference/updateReference are routed through RateLimiterDO's atomic "kvMerge"
 * op (#84's fix reused here per #95) rather than a plain kv.get-then-put: KV has no
 * compare-and-swap, so two concurrent creates for the same new id could both read
 * "not found" and each write, silently letting the second clobber the first with no
 * 409 ever surfacing; two concurrent updates could each merge their patch over a stale
 * read and one write would discard the other's change. Same shape as
 * src/auth/store.ts's createAccount/resetPassword. deleteReference stays a plain
 * read-then-delete — a double-delete is idempotent, so there's no lost-update risk.
 */

import { atomicKvMerge } from "../auth/rateLimiter";

export interface CuratedReference {
	id: string;
	/** The curated fact/claim text itself. */
	text: string;
	/** Citation for this fact — a source name/title, same as TrustedReference.source. */
	source: string;
	sourceUrl?: string;
	/** Free-text identifier of who curated this reference (#19: single-curator is fine for now). */
	curator: string;
	/** ISO timestamp, server-assigned once at creation — never caller-supplied, never changed by an update. */
	dateAdded: string;
	/** Free-text description of where/who this reference applies to. */
	scopeOfApplicability: string;
}

const REFERENCE_KEY_PREFIX = "reference:";

function referenceKey(id: string): string {
	return REFERENCE_KEY_PREFIX + id;
}

export interface CreateReferenceInput {
	id: string;
	text: string;
	source: string;
	sourceUrl?: string;
	curator: string;
	scopeOfApplicability: string;
}

export type CreateReferenceResult = { ok: true; reference: CuratedReference } | { ok: false; error: string };

export async function getReference(kv: KVNamespace, id: string): Promise<CuratedReference | null> {
	const raw = await kv.get(referenceKey(id));
	if (!raw) return null;
	return JSON.parse(raw) as CuratedReference;
}

export async function createReference(
	kv: KVNamespace,
	rateLimiter: DurableObjectNamespace,
	input: CreateReferenceInput,
	now: Date = new Date(),
): Promise<CreateReferenceResult> {
	const reference: CuratedReference = {
		id: input.id,
		text: input.text,
		source: input.source,
		...(input.sourceUrl !== undefined ? { sourceUrl: input.sourceUrl } : {}),
		curator: input.curator,
		dateAdded: now.toISOString(),
		scopeOfApplicability: input.scopeOfApplicability,
	};
	const result = await atomicKvMerge(rateLimiter, referenceKey(reference.id), { ...reference }, { requireExisting: false });
	if (!result.ok) return { ok: false, error: "reference already exists" };
	return { ok: true, reference };
}

export interface UpdateReferenceInput {
	text?: string;
	source?: string;
	sourceUrl?: string;
	curator?: string;
	scopeOfApplicability?: string;
}

export type UpdateReferenceResult = { ok: true; reference: CuratedReference } | { ok: false; error: string };

/** Edits an existing curated reference. `dateAdded` is never touched by an update. */
export async function updateReference(
	kv: KVNamespace,
	rateLimiter: DurableObjectNamespace,
	id: string,
	patch: UpdateReferenceInput,
): Promise<UpdateReferenceResult> {
	const result = await atomicKvMerge(rateLimiter, referenceKey(id), { ...patch }, { requireExisting: true });
	if (!result.ok) return { ok: false, error: "reference not found" };

	const updated = await getReference(kv, id);
	if (!updated) return { ok: false, error: "reference not found" };
	return { ok: true, reference: updated };
}

export type DeleteReferenceResult = { ok: true } | { ok: false; error: string };

export async function deleteReference(kv: KVNamespace, id: string): Promise<DeleteReferenceResult> {
	const existing = await getReference(kv, id);
	if (!existing) return { ok: false, error: "reference not found" };
	await kv.delete(referenceKey(id));
	return { ok: true };
}

export interface ListReferencesResult {
	references: CuratedReference[];
	cursor: string | null;
}

// Bounds one list call's KV reads — same shape as src/audit/log.ts's MAX_LIST_LIMIT.
const MAX_LIST_LIMIT = 200;

export async function listReferences(kv: KVNamespace, limit = MAX_LIST_LIMIT, cursor?: string): Promise<ListReferencesResult> {
	const boundedLimit = Math.min(Math.max(1, limit), MAX_LIST_LIMIT);
	const page = await kv.list({ prefix: REFERENCE_KEY_PREFIX, limit: boundedLimit, cursor });
	const references = await Promise.all(
		page.keys.map(async (key): Promise<CuratedReference | null> => {
			const raw = await kv.get(key.name);
			return raw ? (JSON.parse(raw) as CuratedReference) : null;
		}),
	);
	return {
		references: references.filter((reference): reference is CuratedReference => reference !== null),
		cursor: page.list_complete ? null : (page.cursor ?? null),
	};
}

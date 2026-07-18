/**
 * Append-only access-audit log (#20) — an accountability trail for who viewed what in
 * this portal, before real (non-stub) data goes in. Reuses the NAV_CACHE KV namespace
 * with a distinct key prefix, same pattern src/auth/store.ts already established for
 * account records — see that file's header comment for why a shared namespace with a
 * prefix, not a dedicated one.
 *
 * Hard constraint (issue #20): log metadata only — identity, timestamp, route, and
 * *which* record/citation was involved — never the sensitive record content itself
 * (a navigator entry's body, a QA answer's synthesized text). Every `AuditDetail`
 * variant below is built to make that structurally true: the fields it carries are
 * ids/params/status, not the record text.
 *
 * Keys are `audit:<ISO timestamp>:<uuid>` — the ISO prefix sorts lexicographically in
 * chronological order under `kv.list({ prefix: "audit:" })`, and the uuid suffix keeps
 * two entries written in the same millisecond from colliding on one key. No atomic
 * counter/Durable Object needed: unlike the login-lockout counters (#35), nothing here
 * reads-then-writes a shared value, so there's no TOCTOU race to close.
 */

import type { AuditIdentity } from "../auth/identity";

const AUDIT_KEY_PREFIX = "audit:";

export interface NavigatorAuditDetail {
	kind: "navigator";
	verbosity: string;
	timeScope: string;
	entryIds: string[];
}

export interface QaAuditDetail {
	kind: "qa";
	question: string;
	citationIds: string[];
	status: string;
}

export type AuditDetail = NavigatorAuditDetail | QaAuditDetail;

export interface AuditLogEntry {
	identity: AuditIdentity;
	timestamp: string;
	detail: AuditDetail;
}

function auditKey(timestamp: string): string {
	return `${AUDIT_KEY_PREFIX}${timestamp}:${crypto.randomUUID()}`;
}

/** Records one access. Callers should await this before returning the response it
 * accompanies, so the log entry for a given request is durably written before the
 * caller can act on the fact the request succeeded. */
export async function appendAuditEntry(kv: KVNamespace, identity: AuditIdentity, detail: AuditDetail, now: Date = new Date()): Promise<void> {
	const entry: AuditLogEntry = { identity, timestamp: now.toISOString(), detail };
	await kv.put(auditKey(entry.timestamp), JSON.stringify(entry));
}

export interface ListAuditLogResult {
	entries: AuditLogEntry[];
	cursor: string | null;
}

// Bounds one admin list call's KV reads — an operator paging through history takes
// multiple calls rather than one unbounded fetch.
const MAX_LIST_LIMIT = 100;

/** Read-only admin view (#20 acceptance) — chronological (oldest-first, matching key
 * order), cursor-paginated. */
export async function listAuditLog(kv: KVNamespace, limit = MAX_LIST_LIMIT, cursor?: string): Promise<ListAuditLogResult> {
	const boundedLimit = Math.min(Math.max(1, limit), MAX_LIST_LIMIT);
	const page = await kv.list({ prefix: AUDIT_KEY_PREFIX, limit: boundedLimit, cursor });
	const entries = await Promise.all(
		page.keys.map(async (key): Promise<AuditLogEntry | null> => {
			const raw = await kv.get(key.name);
			return raw ? (JSON.parse(raw) as AuditLogEntry) : null;
		}),
	);
	return {
		entries: entries.filter((entry): entry is AuditLogEntry => entry !== null),
		cursor: page.list_complete ? null : (page.cursor ?? null),
	};
}

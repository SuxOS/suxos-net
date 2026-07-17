// Append-only access audit log — accountability trail for who viewed what, when. Logs
// metadata only (identity, timestamp, route, and for QA: the query + which source was
// cited or that nothing was found) — NEVER the sensitive record content itself. Wired
// into navigator + QA routes in src/index.ts; read-only admin view at /admin/audit-log.
//
// In-memory per-Worker-isolate store, matching this codebase's existing "pure store, no
// external I/O" pattern (see src/tools/*.ts, src/access/accessScopes.ts). Append-only by
// construction: no update or delete is exported.

export interface NavigatorAuditDetail {
	kind: "navigator";
	timeScope: string;
	verbosity: string;
	/** Ids of the entries returned, not their content. */
	entryIds: string[];
}

export interface QaAuditDetail {
	kind: "qa";
	/** The question text itself is metadata about what was asked, not record content. */
	query: string;
	/** Ids of whatever was cited in the answer — never the cited text. */
	citedIds: string[];
	status: string;
}

export type AuditDetail = NavigatorAuditDetail | QaAuditDetail;

export interface AuditEntry {
	id: string;
	identity: string;
	timestamp: string;
	route: string;
	detail: AuditDetail;
}

export interface AuditLog {
	append(entry: Omit<AuditEntry, "id">): AuditEntry;
	list(): AuditEntry[];
}

export function createAuditLog(): AuditLog {
	const entries: AuditEntry[] = [];
	let nextId = 1;

	return {
		append(entry) {
			const recorded: AuditEntry = { id: `audit-${nextId++}`, ...entry };
			entries.push(recorded);
			return recorded;
		},
		list() {
			return [...entries];
		},
	};
}

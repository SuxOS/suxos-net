import { describe, expect, it } from "vitest";
import { createAuditLog } from "./auditLog";

const NAV_ENTRY = {
	identity: "dev@localhost",
	timestamp: "2026-01-01T00:00:00.000Z",
	route: "/api/navigator",
	detail: { kind: "navigator" as const, timeScope: "week", verbosity: "oneline", entryIds: ["stub-001"] },
};

const QA_ENTRY = {
	identity: "dev@localhost",
	timestamp: "2026-01-01T00:00:01.000Z",
	route: "/api/qa",
	detail: { kind: "qa" as const, query: "What happened in March?", citedIds: [], status: "not_implemented" },
};

describe("createAuditLog", () => {
	it("starts empty", () => {
		expect(createAuditLog().list()).toEqual([]);
	});

	it("appends entries and assigns each a unique id", () => {
		const log = createAuditLog();
		const first = log.append(NAV_ENTRY);
		const second = log.append(QA_ENTRY);
		expect(first.id).not.toBe(second.id);
		expect(log.list().map((e) => e.id)).toEqual([first.id, second.id]);
	});

	it("preserves append order", () => {
		const log = createAuditLog();
		log.append(NAV_ENTRY);
		log.append(QA_ENTRY);
		const [a, b] = log.list();
		expect(a.route).toBe("/api/navigator");
		expect(b.route).toBe("/api/qa");
	});

	it("is append-only: mutating the returned list does not affect the store", () => {
		const log = createAuditLog();
		log.append(NAV_ENTRY);
		const snapshot = log.list();
		snapshot.pop();
		expect(log.list().length).toBe(1);
	});

	it("records QA metadata (query, cited ids, status) without any record content field", () => {
		const log = createAuditLog();
		const recorded = log.append(QA_ENTRY);
		expect(Object.keys(recorded.detail).sort()).toEqual(["citedIds", "kind", "query", "status"]);
	});

	it("records navigator metadata (time scope, verbosity, entry ids) without any body/content field", () => {
		const log = createAuditLog();
		const recorded = log.append(NAV_ENTRY);
		expect(Object.keys(recorded.detail).sort()).toEqual(["entryIds", "kind", "timeScope", "verbosity"]);
	});
});

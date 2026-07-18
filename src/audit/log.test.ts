import { describe, expect, it } from "vitest";
import { createMemoryKv } from "../test/kvMock";
import { appendAuditEntry, listAuditLog, type AuditLogEntry } from "./log";
import { operatorIdentity, recipientIdentity } from "../auth/identity";

describe("appendAuditEntry / listAuditLog", () => {
	it("records an entry that round-trips through listAuditLog", async () => {
		const kv = createMemoryKv();
		await appendAuditEntry(kv, recipientIdentity("hank"), {
			kind: "navigator",
			verbosity: "oneline",
			timeScope: "week",
			entryIds: ["stub-001"],
		});

		const { entries } = await listAuditLog(kv);
		expect(entries).toHaveLength(1);
		expect(entries[0].identity).toEqual({ kind: "recipient-username", username: "hank" });
		expect(entries[0].detail).toEqual({ kind: "navigator", verbosity: "oneline", timeScope: "week", entryIds: ["stub-001"] });
		expect(typeof entries[0].timestamp).toBe("string");
	});

	it("never stores record body content — only ids/params/status", async () => {
		const kv = createMemoryKv();
		await appendAuditEntry(kv, recipientIdentity("hank"), {
			kind: "qa",
			question: "what happened in March?",
			citationIds: ["stub-cite-002"],
			status: "not_implemented",
		});

		const { entries } = await listAuditLog(kv);
		const detail = entries[0].detail as { kind: "qa"; question: string; citationIds: string[]; status: string };
		expect(Object.keys(detail).sort()).toEqual(["citationIds", "kind", "question", "status"]);
	});

	it("returns entries in chronological (oldest-first) order", async () => {
		const kv = createMemoryKv();
		await appendAuditEntry(kv, recipientIdentity("a"), { kind: "qa", question: "q1", citationIds: [], status: "not_implemented" }, new Date("2026-01-01T00:00:00.000Z"));
		await appendAuditEntry(kv, recipientIdentity("b"), { kind: "qa", question: "q2", citationIds: [], status: "not_implemented" }, new Date("2026-01-02T00:00:00.000Z"));
		await appendAuditEntry(kv, recipientIdentity("c"), { kind: "qa", question: "q3", citationIds: [], status: "not_implemented" }, new Date("2026-01-03T00:00:00.000Z"));

		const { entries } = await listAuditLog(kv);
		expect(entries.map((e) => (e.detail as { question: string }).question)).toEqual(["q1", "q2", "q3"]);
	});

	it("distinguishes operator vs recipient identity in the stored entry", async () => {
		const kv = createMemoryKv();
		await appendAuditEntry(kv, operatorIdentity("dev@localhost"), { kind: "navigator", verbosity: "bare", timeScope: "all", entryIds: [] });
		const { entries } = await listAuditLog(kv);
		expect(entries[0].identity).toEqual({ kind: "operator-access-email", email: "dev@localhost" });
	});

	it("paginates via cursor without duplicating or dropping entries", async () => {
		const kv = createMemoryKv();
		for (let i = 0; i < 5; i++) {
			await appendAuditEntry(
				kv,
				recipientIdentity("hank"),
				{ kind: "qa", question: `q${i}`, citationIds: [], status: "not_implemented" },
				new Date(2026, 0, i + 1),
			);
		}

		const firstPage = await listAuditLog(kv, 2);
		expect(firstPage.entries).toHaveLength(2);
		expect(firstPage.cursor).not.toBeNull();

		const secondPage = await listAuditLog(kv, 2, firstPage.cursor ?? undefined);
		expect(secondPage.entries).toHaveLength(2);

		const thirdPage = await listAuditLog(kv, 2, secondPage.cursor ?? undefined);
		expect(thirdPage.entries).toHaveLength(1);
		expect(thirdPage.cursor).toBeNull();

		const all = [...firstPage.entries, ...secondPage.entries, ...thirdPage.entries].map((e: AuditLogEntry) => (e.detail as { question: string }).question);
		expect(new Set(all).size).toBe(5);
	});

	it("bounds the list limit to the max even if a caller asks for more", async () => {
		const kv = createMemoryKv();
		for (let i = 0; i < 3; i++) {
			await appendAuditEntry(kv, recipientIdentity("hank"), { kind: "qa", question: `q${i}`, citationIds: [], status: "not_implemented" });
		}
		const { entries } = await listAuditLog(kv, 10_000);
		expect(entries).toHaveLength(3);
	});
});

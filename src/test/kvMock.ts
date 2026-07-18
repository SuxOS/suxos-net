/**
 * Minimal in-memory KVNamespace stand-in for tests — just enough of the KV surface
 * (get/put/delete/list) that src/auth/store.ts and src/audit/log.ts use. Not a full KV
 * emulation (no expiration, no metadata) — extend if a test needs more. `list`'s
 * cursor is just the next start index as a string — not real KV's opaque cursor
 * format, but enough to exercise pagination against this mock.
 */
export function createMemoryKv(): KVNamespace {
	const store = new Map<string, string>();
	return {
		async get(key: string) {
			return store.has(key) ? store.get(key)! : null;
		},
		async put(key: string, value: string) {
			store.set(key, value);
		},
		async delete(key: string) {
			store.delete(key);
		},
		async list(options?: { prefix?: string; limit?: number; cursor?: string }) {
			const prefix = options?.prefix ?? "";
			const limit = options?.limit ?? 1000;
			const startIndex = options?.cursor ? Number(options.cursor) : 0;
			const matching = [...store.keys()].filter((key) => key.startsWith(prefix)).sort();
			const page = matching.slice(startIndex, startIndex + limit);
			const listComplete = startIndex + page.length >= matching.length;
			return {
				keys: page.map((name) => ({ name })),
				list_complete: listComplete,
				cursor: listComplete ? undefined : String(startIndex + page.length),
			};
		},
	} as unknown as KVNamespace;
}

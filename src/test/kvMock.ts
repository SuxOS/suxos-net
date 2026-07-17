/**
 * Minimal in-memory KVNamespace stand-in for tests — just enough of the KV surface
 * (get/put/delete) that src/auth/store.ts uses. Not a full KV emulation (no
 * expiration, no list, no metadata) — extend if a test needs more.
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
	} as unknown as KVNamespace;
}

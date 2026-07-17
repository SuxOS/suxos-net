// Shared in-memory KVNamespace fake for Worker Env test mocks. Prefer this over
// `{} as KVNamespace` casts: an empty cast only fails when a test happens to
// exercise a call site that touches the binding, whereas this fake makes
// get/put actually work so new code paths fail loudly and correctly instead
// of silently passing until a later test file trips over the gap (see #43).
export function createInMemoryKv(): KVNamespace {
	const store = new Map<string, string>();
	return {
		get: async (key: string) => store.get(key) ?? null,
		put: async (key: string, value: string) => {
			store.set(key, value);
		},
	} as unknown as KVNamespace;
}

// In-memory DurableObjectNamespace fake, same spirit as createInMemoryKv in kv.ts:
// just enough of the real interface for a DO-backed unit under test to run against
// in plain-Node vitest (no Miniflare/workerd).
//
// One instance is kept per idFromName so per-identity state persists across calls,
// like the real thing. Crucially, calls to the same instance are also queued so only
// one `fetch()` runs at a time — mirroring the real platform's "input gate" (a DO
// instance never interleaves two requests' JS, even across `await` points). Without
// that queueing this fake couldn't actually exercise the atomicity guarantee DOs are
// meant to provide; concurrent callers would just race like the old KV version did.

export function createInMemoryDurableObjectNamespace(construct: (state: DurableObjectState) => DurableObject): DurableObjectNamespace {
	const instances = new Map<string, DurableObject>();
	const queues = new Map<string, Promise<unknown>>();

	function instanceFor(name: string): DurableObject {
		let instance = instances.get(name);
		if (!instance) {
			const store = new Map<string, unknown>();
			const state = {
				storage: {
					get: async (key: string) => store.get(key),
					put: async (key: string, value: unknown) => {
						store.set(key, value);
					},
				},
			} as unknown as DurableObjectState;
			instance = construct(state);
			instances.set(name, instance);
		}
		return instance;
	}

	function stubFor(name: string): DurableObjectStub {
		return {
			fetch: (input: RequestInfo | URL, init?: RequestInit) => {
				const instance = instanceFor(name);
				const request = new Request(input, init);
				const runNext = () => instance.fetch(request);
				const previous = queues.get(name) ?? Promise.resolve();
				const result = previous.then(runNext, runNext);
				queues.set(
					name,
					result.catch(() => undefined),
				);
				return result;
			},
		} as unknown as DurableObjectStub;
	}

	return {
		idFromName: (name: string) => ({ toString: () => name, name }) as unknown as DurableObjectId,
		get: (id: DurableObjectId) => stubFor(id.toString()),
	} as unknown as DurableObjectNamespace;
}

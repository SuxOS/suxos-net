/**
 * In-memory DurableObjectNamespace stand-in for tests — the DO analogue of
 * src/test/kvMock.ts. It runs the REAL RateLimiterDO class (its actual
 * increment/window/threshold/lockout logic) against an in-memory storage, so tests
 * exercise the production code path, not a reimplementation.
 *
 * It faithfully models the DO's defining guarantee: per-instance serialisation. Each
 * stub.fetch for a given id is chained onto that instance's tail promise, so requests
 * to one id run strictly one-at-a-time — exactly the input-gate behaviour that closes
 * the TOCTOU race. Without this, concurrent get-then-put would interleave in the mock
 * just as it did in the old KV code; with it, the concurrency test in
 * src/auth/rateLimiter.test.ts genuinely proves the atomic limit holds under a burst.
 * This is the same single-threaded model runInDurableObject / miniflare provide; it is
 * NOT the real workerd runtime, so it does not exercise cross-region placement or
 * eviction — only the counter logic and its serialisation contract.
 */
import { RateLimiterDO } from "../auth/rateLimiter";

function createMemoryStorage(): DurableObjectStorage {
	const store = new Map<string, unknown>();
	return {
		async get(key: string) {
			return store.has(key) ? store.get(key) : undefined;
		},
		async put(key: string, value: unknown) {
			store.set(key, value);
		},
		async delete(key: string) {
			return store.delete(key);
		},
	} as unknown as DurableObjectStorage;
}

interface Instance {
	inst: RateLimiterDO;
	tail: Promise<unknown>;
}

export function createRateLimiterNamespace(): DurableObjectNamespace {
	const instances = new Map<string, Instance>();
	const entryFor = (name: string): Instance => {
		let entry = instances.get(name);
		if (!entry) {
			const state = { storage: createMemoryStorage() } as unknown as DurableObjectState;
			entry = { inst: new RateLimiterDO(state), tail: Promise.resolve() };
			instances.set(name, entry);
		}
		return entry;
	};

	return {
		idFromName(name: string) {
			return { name } as unknown as DurableObjectId;
		},
		get(id: DurableObjectId) {
			const name = (id as unknown as { name: string }).name;
			return {
				fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
					const entry = entryFor(name);
					// Serialise like a real DO instance's input gate: this request runs
					// only after the previous one for this id has fully settled.
					const run = entry.tail.then(() => entry.inst.fetch(new Request(input as RequestInfo, init)));
					entry.tail = run.then(
						() => undefined,
						() => undefined,
					);
					return run;
				},
			} as unknown as DurableObjectStub;
		},
	} as unknown as DurableObjectNamespace;
}

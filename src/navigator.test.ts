import { describe, expect, it } from "vitest";
import {
	getNavigatorView,
	isTimeScope,
	isVerbosity,
	TIME_SCOPE_VALUES,
	VERBOSITY_VALUES,
	type TimeScope,
	type Verbosity,
} from "./navigator";

describe("verbosity/time-scope guards", () => {
	it("accepts every declared verbosity value", () => {
		for (const v of VERBOSITY_VALUES) expect(isVerbosity(v)).toBe(true);
	});

	it("accepts every declared time-scope value", () => {
		for (const t of TIME_SCOPE_VALUES) expect(isTimeScope(t)).toBe(true);
	});

	it("rejects invalid verbosity/time-scope strings", () => {
		expect(isVerbosity("essay")).toBe(false);
		expect(isTimeScope("decade")).toBe(false);
		expect(isVerbosity("")).toBe(false);
	});
});

describe("getNavigatorView", () => {
	for (const verbosity of VERBOSITY_VALUES) {
		for (const timeScope of TIME_SCOPE_VALUES) {
			it(`produces a well-shaped stub response for ${verbosity}/${timeScope}`, () => {
				// "all" always has entries; "week"/"year" depend on how far the stub dates are
				// from wall-clock "now", so only shape (not non-emptiness) is asserted generically.
				const result = getNavigatorView(verbosity as Verbosity, timeScope as TimeScope);
				expect(result.verbosity).toBe(verbosity);
				expect(result.timeScope).toBe(timeScope);
				expect(Array.isArray(result.entries)).toBe(true);
				expect(() => new Date(result.generatedAt).toISOString()).not.toThrow();
				for (const entry of result.entries) {
					expect(typeof entry.id).toBe("string");
					expect(typeof entry.date).toBe("string");
					expect(typeof entry.title).toBe("string");
					expect(Array.isArray(entry.citationIds)).toBe(true);
				}
			});
		}
	}

	it("returns every stub entry for 'all'", () => {
		expect(getNavigatorView("bare", "all").entries.length).toBeGreaterThan(0);
	});

	it("omits body text at bare and oneline verbosity", () => {
		expect(getNavigatorView("bare", "all").entries.every((e) => e.body === null)).toBe(true);
		expect(getNavigatorView("oneline", "all").entries.every((e) => e.body === null)).toBe(true);
	});

	it("includes body text at paragraph and narrative verbosity", () => {
		expect(getNavigatorView("paragraph", "all").entries.every((e) => typeof e.body === "string")).toBe(true);
		expect(getNavigatorView("narrative", "all").entries.every((e) => typeof e.body === "string")).toBe(true);
	});

	it("filters 'week' to a strict subset of 'all' relative to a fixed reference date", () => {
		// Reference date well past both stub dates (2026-01-05, 2026-03-19) so "week" is empty
		// and "all" has both — demonstrating the filter without depending on wall-clock "now".
		const now = new Date("2026-07-17T00:00:00Z");
		const all = getNavigatorView("bare", "all", now).entries;
		const week = getNavigatorView("bare", "week", now).entries;
		expect(all.length).toBeGreaterThan(0);
		expect(week.length).toBeLessThan(all.length);
		for (const entry of week) {
			expect(all.some((e) => e.id === entry.id)).toBe(true);
		}
	});

	it("'year' includes entries within the last year but excludes entries beyond it", () => {
		const now = new Date("2026-07-17T00:00:00Z");
		const year = getNavigatorView("bare", "year", now).entries;
		expect(year.map((e) => e.id).sort()).toEqual(["stub-001", "stub-002"]);

		const farFuture = new Date("2028-01-01T00:00:00Z");
		expect(getNavigatorView("bare", "year", farFuture).entries).toEqual([]);
	});

	it("only returns entries at or before the reference date", () => {
		const beforeAnyEntry = new Date("2025-01-01T00:00:00Z");
		expect(getNavigatorView("bare", "week", beforeAnyEntry).entries).toEqual([]);
		expect(getNavigatorView("bare", "year", beforeAnyEntry).entries).toEqual([]);
	});
});

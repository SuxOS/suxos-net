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
				const result = getNavigatorView(verbosity as Verbosity, timeScope as TimeScope);
				expect(result.verbosity).toBe(verbosity);
				expect(result.timeScope).toBe(timeScope);
				expect(Array.isArray(result.entries)).toBe(true);
				expect(result.entries.length).toBeGreaterThan(0);
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

	it("omits body text at bare and oneline verbosity", () => {
		expect(getNavigatorView("bare", "week").entries.every((e) => e.body === null)).toBe(true);
		expect(getNavigatorView("oneline", "week").entries.every((e) => e.body === null)).toBe(true);
	});

	it("includes body text at paragraph and narrative verbosity", () => {
		expect(getNavigatorView("paragraph", "all").entries.every((e) => typeof e.body === "string")).toBe(true);
		expect(getNavigatorView("narrative", "all").entries.every((e) => typeof e.body === "string")).toBe(true);
	});
});

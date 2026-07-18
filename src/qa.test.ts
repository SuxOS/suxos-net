import { describe, expect, it } from "vitest";
import { askQuestion, isQaFormat, QA_FORMAT_VALUES } from "./qa";

describe("askQuestion stub", () => {
	it("returns the not-implemented shape without fabricating an answer or citation", () => {
		const result = askQuestion("What happened in March?");
		expect(result.question).toBe("What happened in March?");
		expect(result.status).toBe("not_implemented");
		expect(result.citations).toEqual([]);
		expect(typeof result.answer).toBe("string");
		expect(result.answer.length).toBeGreaterThan(0);
	});

	it("echoes back arbitrary question text unchanged", () => {
		const question = "";
		expect(askQuestion(question).question).toBe(question);
	});

	it("defaults to the standard format", () => {
		expect(askQuestion("What happened in March?").format).toBe("standard");
	});

	it("shortens the answer without changing citations (still empty) in haiku format", () => {
		const standard = askQuestion("What happened in March?", "standard");
		const haiku = askQuestion("What happened in March?", "haiku");
		expect(haiku.format).toBe("haiku");
		expect(haiku.answer.length).toBeLessThan(standard.answer.length);
		expect(haiku.citations).toEqual([]);
	});
});

describe("isQaFormat", () => {
	it("accepts every declared QA_FORMAT_VALUES entry", () => {
		for (const value of QA_FORMAT_VALUES) expect(isQaFormat(value)).toBe(true);
	});

	it("rejects an arbitrary string", () => {
		expect(isQaFormat("essay")).toBe(false);
	});
});

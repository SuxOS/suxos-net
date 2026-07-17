import { describe, expect, it } from "vitest";
import { askQuestion } from "./qa";

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
});

import { describe, expect, it } from "vitest";
import { chunkMarkdown } from "./chunk";

describe("chunkMarkdown", () => {
	it("splits a note into one chunk per heading, each tagged with the source path", () => {
		const note = `---
title: Example
---

# Example

## Section A
Some text about A.

## Section B
Some text about B.
`;
		const chunks = chunkMarkdown("records/example.md", note);

		expect(chunks.length).toBeGreaterThanOrEqual(2);
		for (const chunk of chunks) {
			expect(chunk.sourcePath).toBe("records/example.md");
			expect(chunk.text.length).toBeGreaterThan(0);
		}

		const headings = chunks.map((c) => c.heading);
		expect(headings).toContain("Section A");
		expect(headings).toContain("Section B");
	});

	it("strips YAML frontmatter from every chunk's text", () => {
		const note = `---
secret: should-not-appear
---

## Heading
Body text.
`;
		const chunks = chunkMarkdown("records/foo.md", note);
		for (const chunk of chunks) {
			expect(chunk.text).not.toContain("should-not-appear");
		}
	});

	it("falls back to a single note-level chunk when there are no headings", () => {
		const note = `---
title: No headings
---

Just a paragraph, no heading markers at all.
`;
		const chunks = chunkMarkdown("records/plain.md", note);
		expect(chunks).toHaveLength(1);
		expect(chunks[0].heading).toBeNull();
		expect(chunks[0].sourcePath).toBe("records/plain.md");
	});

	it("returns no chunks for a note that is empty after stripping frontmatter", () => {
		const note = `---
title: Empty
---
`;
		expect(chunkMarkdown("records/empty.md", note)).toEqual([]);
	});

	it("splits an oversized section into multiple paragraph-level chunks, all under the same heading", () => {
		const bigParagraphs = Array.from({ length: 20 }, (_, i) => `Paragraph ${i} `.repeat(30)).join("\n\n");
		const note = `## Big Section\n${bigParagraphs}\n`;
		const chunks = chunkMarkdown("records/big.md", note);

		expect(chunks.length).toBeGreaterThan(1);
		for (const chunk of chunks) {
			expect(chunk.heading).toBe("Big Section");
			expect(chunk.sourcePath).toBe("records/big.md");
		}
	});

	it("assigns sequential, unique chunkIndex values within a note", () => {
		const note = `## A\ntext a\n\n## B\ntext b\n\n## C\ntext c\n`;
		const chunks = chunkMarkdown("records/seq.md", note);
		expect(chunks.map((c) => c.chunkIndex)).toEqual(chunks.map((_, i) => i));
	});

	it("attributes an intro paragraph before the first heading to the note, not a heading", () => {
		const note = `# Title\nIntro text before any subheading.\n\n## First\nBody.\n`;
		const chunks = chunkMarkdown("records/intro.md", note);
		expect(chunks[0].heading).toBeNull();
		expect(chunks[0].text).toContain("Intro text");
	});
});

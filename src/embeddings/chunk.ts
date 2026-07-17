// Chunks a suxvault markdown note into retrieval-sized pieces. Deliberately simple —
// a heading-based splitter with a paragraph-level fallback for oversized sections, not
// a general-purpose markdown parser. Every chunk carries its source note path (and
// heading, if split below note-level) so it always maps back to a real citation —
// see the design doc §2 hard constraint: no vector without a resolvable source.

export interface Chunk {
	/** Path of the source note within suxvault, e.g. "records/biographical/Employment.md". */
	sourcePath: string;
	/** Heading text this chunk falls under, if the note has headings; null at note level. */
	heading: string | null;
	/** 0-based index of this chunk within its source note — part of the stable vector id. */
	chunkIndex: number;
	/** The chunk's plain text (frontmatter stripped, heading marker stripped). */
	text: string;
}

/** Frontmatter is YAML between a leading `---` pair — not content, never embedded. */
function stripFrontmatter(markdown: string): string {
	const match = markdown.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
	return match ? markdown.slice(match[0].length) : markdown;
}

/** Split an oversized section into paragraph-sized pieces, respecting a rough char budget. */
function splitOversizedSection(text: string, maxChars: number): string[] {
	const paragraphs = text
		.split(/\n{2,}/)
		.map((p) => p.trim())
		.filter((p) => p.length > 0);

	if (paragraphs.length === 0) return [];

	const pieces: string[] = [];
	let current = "";
	for (const paragraph of paragraphs) {
		const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
		if (candidate.length > maxChars && current) {
			pieces.push(current);
			current = paragraph;
		} else {
			current = candidate;
		}
	}
	if (current) pieces.push(current);
	return pieces;
}

const MAX_CHUNK_CHARS = 1800;

/**
 * Split one markdown note into chunks. Splits on `##`/`###`-level headings when
 * present; a heading section that's still oversized is further split by paragraph.
 * A note with no headings at all becomes one or more paragraph-level chunks under
 * the note itself (heading: null).
 */
export function chunkMarkdown(sourcePath: string, markdown: string): Chunk[] {
	const body = stripFrontmatter(markdown).trim();
	if (body.length === 0) return [];

	const headingPattern = /^(#{2,3})\s+(.+)$/gm;
	const sections: { heading: string | null; text: string }[] = [];

	let match: RegExpExecArray | null;
	const matches: { start: number; heading: string }[] = [];
	while ((match = headingPattern.exec(body)) !== null) {
		matches.push({ start: match.index, heading: match[2].trim() });
	}

	if (matches.length === 0) {
		sections.push({ heading: null, text: body });
	} else {
		// Anything before the first heading (e.g. an intro paragraph or a leading H1) is
		// its own section, attributed to the note rather than a specific heading.
		const preamble = body.slice(0, matches[0].start).trim();
		if (preamble.length > 0) sections.push({ heading: null, text: preamble });

		for (let i = 0; i < matches.length; i++) {
			const start = matches[i].start;
			const end = i + 1 < matches.length ? matches[i + 1].start : body.length;
			const sectionText = body.slice(start, end).trim();
			if (sectionText.length > 0) sections.push({ heading: matches[i].heading, text: sectionText });
		}
	}

	const chunks: Chunk[] = [];
	let chunkIndex = 0;
	for (const section of sections) {
		const pieces = section.text.length > MAX_CHUNK_CHARS
			? splitOversizedSection(section.text, MAX_CHUNK_CHARS)
			: [section.text];

		for (const piece of pieces) {
			chunks.push({ sourcePath, heading: section.heading, chunkIndex, text: piece });
			chunkIndex++;
		}
	}

	return chunks;
}

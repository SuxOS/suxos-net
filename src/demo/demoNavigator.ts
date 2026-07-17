// Demo-only navigator view builder — renders demoData.ts's fictional records through
// the real verbositySummarizer tool, so /demo/navigator exercises the same rendering
// pipeline navigator.ts uses, just over obviously-fictional data instead of the
// two-entry STUB_ENTRIES. See demoData.ts for the "not real" disclaimer.

import { summarizeAtVerbosity, type Verbosity as ToolVerbosity } from "../tools/verbositySummarizer";
import type { Verbosity, TimeScope } from "../navigator";
import { demoRecords } from "./demoData";

export interface DemoNavigatorEntry {
	id: string;
	date: string;
	title: string;
	body: string | null;
	citationIds: string[];
}

export interface DemoNavigatorResponse {
	verbosity: Verbosity;
	timeScope: TimeScope;
	entries: DemoNavigatorEntry[];
	generatedAt: string;
	notice: string;
}

const NOTICE = "FICTIONAL DEMO DATA — not the user's real information. Do not treat as real.";

// Same body-visibility mapping navigator.ts uses: "oneline" hides body (title carries
// the summary), "narrative" is the tool's "full".
function toToolVerbosity(verbosity: Verbosity): ToolVerbosity {
	if (verbosity === "bare" || verbosity === "oneline") return "bare";
	if (verbosity === "narrative") return "full";
	return verbosity;
}

function titleFor(text: string): string {
	const firstSentence = text.match(/^.*?[.!?](?:\s|$)/);
	const candidate = (firstSentence ? firstSentence[0] : text).trim();
	return candidate.length <= 80 ? candidate : `${candidate.slice(0, 79)}…`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Demo time-scope filtering is anchored to the *latest* record's date rather than the
 * real current date, since the fictional dataset lives entirely in the past — "a
 * week"/"a year" of a fictional timeline should mean relative to that timeline's own
 * end, not to whatever day it happens to be when someone loads the demo.
 */
function withinTimeScope(recordDate: string, timeScope: TimeScope, anchorMs: number): boolean {
	if (timeScope === "all") return true;
	const recordMs = new Date(recordDate).getTime();
	const spanMs = timeScope === "week" ? 7 * DAY_MS : 365 * DAY_MS;
	return anchorMs - recordMs <= spanMs && recordMs <= anchorMs;
}

export function buildDemoNavigatorView(verbosity: Verbosity, timeScope: TimeScope): DemoNavigatorResponse {
	const anchorMs = Math.max(...demoRecords.map((r) => new Date(r.date).getTime()));
	const inScope = demoRecords.filter((r) => withinTimeScope(r.date, timeScope, anchorMs));

	const rendered = summarizeAtVerbosity(
		inScope.map((r) => ({ id: r.id, date: r.date, text: r.text, citations: r.citations })),
		toToolVerbosity(verbosity),
	);

	const entries: DemoNavigatorEntry[] = inScope.map((record, i) => ({
		id: record.id,
		date: record.date,
		title: titleFor(record.text),
		body: rendered[i].rendered,
		citationIds: record.citations,
	}));

	return {
		verbosity,
		timeScope,
		entries,
		generatedAt: new Date().toISOString(),
		notice: NOTICE,
	};
}

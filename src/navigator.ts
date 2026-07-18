// The 2D navigator: verbosity axis × time-scope axis, one control instead of
// separate "timeline" and "report" views (design doc §2). Wide time-scope + high
// verbosity is self-limiting by the renderer, not by this module.
//
// Verbosity rendering itself is delegated to the generic src/tools/verbositySummarizer
// tool rather than duplicated here.

import { summarizeAtVerbosity } from "./tools/verbositySummarizer";
import { toToolVerbosity, withinTimeScope as withinTimeScopeAt } from "./tools/navigatorScope";

export type Verbosity = "bare" | "oneline" | "paragraph" | "narrative";
export type TimeScope = "week" | "year" | "all";

export interface NavigatorEntry {
	id: string;
	date: string;
	title: string;
	body: string | null;
	citationIds: string[];
}

export interface NavigatorResponse {
	verbosity: Verbosity;
	timeScope: TimeScope;
	entries: NavigatorEntry[];
	generatedAt: string;
}

export const VERBOSITY_VALUES: readonly Verbosity[] = ["bare", "oneline", "paragraph", "narrative"];
export const TIME_SCOPE_VALUES: readonly TimeScope[] = ["week", "year", "all"];

export function isVerbosity(value: string): value is Verbosity {
	return (VERBOSITY_VALUES as readonly string[]).includes(value);
}

export function isTimeScope(value: string): value is TimeScope {
	return (TIME_SCOPE_VALUES as readonly string[]).includes(value);
}

// suxvault is currently empty structure (no real content) — these are obviously
// synthetic placeholder entries, not a preview of real record data.
const STUB_ENTRIES: NavigatorEntry[] = [
	{
		id: "stub-001",
		date: "2026-01-05",
		title: "Sample Event A",
		body: "This is placeholder narrative text for Sample Event A, standing in for a real record entry.",
		citationIds: ["stub-cite-001"],
	},
	{
		id: "stub-002",
		date: "2026-03-19",
		title: "Sample Event B",
		body: "This is placeholder narrative text for Sample Event B, standing in for a real record entry.",
		citationIds: ["stub-cite-002"],
	},
];

function projectEntry(entry: NavigatorEntry, verbosity: Verbosity): NavigatorEntry {
	const [rendered] = summarizeAtVerbosity(
		[{ id: entry.id, date: entry.date, text: entry.body ?? "", citations: entry.citationIds }],
		toToolVerbosity(verbosity),
	);
	return { ...entry, body: rendered.rendered };
}

export function getNavigatorView(verbosity: Verbosity, timeScope: TimeScope, now: Date = new Date()): NavigatorResponse {
	return {
		verbosity,
		timeScope,
		entries: STUB_ENTRIES.filter((entry) => withinTimeScopeAt(entry.date, timeScope, now.getTime())).map((entry) =>
			projectEntry(entry, verbosity),
		),
		generatedAt: new Date().toISOString(),
	};
}

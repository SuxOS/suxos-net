// The 2D navigator: verbosity axis × time-scope axis, one control instead of
// separate "timeline" and "report" views (design doc §2). Wide time-scope + high
// verbosity is self-limiting by the renderer, not by this module.
//
// Verbosity rendering itself is delegated to the generic src/tools/verbositySummarizer
// tool rather than duplicated here.

import { summarizeAtVerbosity, type Verbosity as ToolVerbosity } from "./tools/verbositySummarizer";

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

// navigator's body-visibility contract differs slightly from the generic tool's:
// navigator hides body entirely (not just collapses it) at "oneline" too, because the
// entry's `title` already carries the oneline-equivalent summary here. So both "bare"
// and "oneline" map to the tool's "bare" for rendering purposes; "narrative" is the
// tool's "full" (same top-of-scale meaning, different name kept for compatibility).
function toToolVerbosity(verbosity: Verbosity): ToolVerbosity {
	if (verbosity === "bare" || verbosity === "oneline") return "bare";
	if (verbosity === "narrative") return "full";
	return verbosity;
}

function projectEntry(entry: NavigatorEntry, verbosity: Verbosity): NavigatorEntry {
	const [rendered] = summarizeAtVerbosity(
		[{ id: entry.id, date: entry.date, text: entry.body ?? "", citations: entry.citationIds }],
		toToolVerbosity(verbosity),
	);
	return { ...entry, body: rendered.rendered };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const TIME_SCOPE_WINDOW_DAYS: Record<Exclude<TimeScope, "all">, number> = { week: 7, year: 365 };

// "week"/"year" are a trailing window ending at `now` (design doc §2: "a week → the whole
// span"); "all" passes every entry through untouched.
function withinTimeScope(entry: NavigatorEntry, timeScope: TimeScope, now: Date): boolean {
	if (timeScope === "all") return true;
	const entryMs = new Date(entry.date).getTime();
	const windowMs = TIME_SCOPE_WINDOW_DAYS[timeScope] * DAY_MS;
	return entryMs <= now.getTime() && now.getTime() - entryMs <= windowMs;
}

export function getNavigatorView(verbosity: Verbosity, timeScope: TimeScope, now: Date = new Date()): NavigatorResponse {
	return {
		verbosity,
		timeScope,
		entries: STUB_ENTRIES.filter((entry) => withinTimeScope(entry, timeScope, now)).map((entry) =>
			projectEntry(entry, verbosity),
		),
		generatedAt: new Date().toISOString(),
	};
}

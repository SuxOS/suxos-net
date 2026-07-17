// The 2D navigator: verbosity axis × time-scope axis, one control instead of
// separate "timeline" and "report" views (design doc §2). Wide time-scope + high
// verbosity is self-limiting by the renderer, not by this module.

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
	if (verbosity === "bare") return { ...entry, title: entry.title, body: null };
	if (verbosity === "oneline") return { ...entry, body: null };
	return entry;
}

export function getNavigatorView(verbosity: Verbosity, timeScope: TimeScope): NavigatorResponse {
	return {
		verbosity,
		timeScope,
		entries: STUB_ENTRIES.map((entry) => projectEntry(entry, verbosity)),
		generatedAt: new Date().toISOString(),
	};
}

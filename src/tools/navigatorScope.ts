// Shared verbosity-mapping and time-scope-filtering logic for navigator.ts and
// src/demo/demoNavigator.ts — both project the same Verbosity/TimeScope axes onto the
// generic verbositySummarizer tool and the same trailing-window filter, just over
// different data sources (real stub entries vs. fictional demo records).

import type { Verbosity as ToolVerbosity } from "./verbositySummarizer";

export type Verbosity = "bare" | "oneline" | "paragraph" | "narrative";
export type TimeScope = "week" | "year" | "all";

const DAY_MS = 24 * 60 * 60 * 1000;
const TIME_SCOPE_WINDOW_DAYS: Record<Exclude<TimeScope, "all">, number> = { week: 7, year: 365 };

// Both navigators hide body entirely (not just collapse it) at "oneline" too, because the
// entry's `title` already carries the oneline-equivalent summary. So both "bare" and
// "oneline" map to the tool's "bare" for rendering purposes; "narrative" is the tool's
// "full" (same top-of-scale meaning, different name kept for compatibility).
export function toToolVerbosity(verbosity: Verbosity): ToolVerbosity {
	if (verbosity === "bare" || verbosity === "oneline") return "bare";
	if (verbosity === "narrative") return "full";
	return verbosity;
}

// "week"/"year" are a trailing window ending at `anchorMs`; "all" passes every entry
// through untouched. `anchorMs` is caller-supplied so navigator.ts can anchor to wall-clock
// "now" while demoNavigator.ts anchors to its fictional dataset's latest record.
export function withinTimeScope(dateStr: string, timeScope: TimeScope, anchorMs: number): boolean {
	if (timeScope === "all") return true;
	const entryMs = new Date(dateStr).getTime();
	const windowMs = TIME_SCOPE_WINDOW_DAYS[timeScope] * DAY_MS;
	return entryMs <= anchorMs && anchorMs - entryMs <= windowMs;
}

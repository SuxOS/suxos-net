// QA bot stub. Real answers are retrieval over the citation graph (design doc §3):
// every response should be a cited pointer into the record, never free-form chat.
//
// TODO(F-005, F-028): wire real retrieval once F-005 (semantic vault search —
// `vault_semantic` fn, Workers AI → Vectorize hybrid recall) and F-028 (fleshed-out
// bibliography / citation graph) land in `sux` + `suxvault` (see FEATURE-IDEAS.md).
// Until then this function must not fabricate an answer or a citation.

import { toOneLine } from "./tools/verbositySummarizer";

// "Haiku mode" (design doc §3): an opt-in compact response format, shared by
// /api/qa and /demo/qa. Reformats the same cited text more tersely — it never
// changes which citations are returned, so it carries no fabrication risk.
export type QaFormat = "standard" | "haiku";

export const QA_FORMAT_VALUES: readonly QaFormat[] = ["standard", "haiku"];

export function isQaFormat(value: string): value is QaFormat {
	return (QA_FORMAT_VALUES as readonly string[]).includes(value);
}

export interface QaResponse {
	question: string;
	answer: string;
	citations: string[];
	status: "not_implemented";
	format: QaFormat;
}

export function askQuestion(question: string, format: QaFormat = "standard"): QaResponse {
	const answer = "QA retrieval is not yet wired to the citation graph. This is a stub response.";
	return {
		question,
		answer: format === "haiku" ? toOneLine(answer) : answer,
		citations: [],
		status: "not_implemented",
		format,
	};
}

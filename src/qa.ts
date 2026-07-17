// QA bot stub. Real answers are retrieval over the citation graph (design doc §3):
// every response should be a cited pointer into the record, never free-form chat.
//
// TODO(F-005, F-028): wire real retrieval once F-005 (semantic vault search —
// `vault_semantic` fn, Workers AI → Vectorize hybrid recall) and F-028 (fleshed-out
// bibliography / citation graph) land in `sux` + `suxvault` (see FEATURE-IDEAS.md).
// Until then this function must not fabricate an answer or a citation.

export interface QaResponse {
	question: string;
	answer: string;
	citations: string[];
	status: "not_implemented";
}

export function askQuestion(question: string): QaResponse {
	return {
		question,
		answer: "QA retrieval is not yet wired to the citation graph. This is a stub response.",
		citations: [],
		status: "not_implemented",
	};
}

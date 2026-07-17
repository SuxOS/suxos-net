// Real retrieval-backed QA (issue #31 / design doc §3): embed the question, retrieve
// top-k chunks from the suxvault-notes Vectorize index (populated by
// src/embeddings/sync.ts), and — only if something clears the similarity threshold —
// call an LLM whose context contains ONLY those retrieved chunks. This is an
// architectural guarantee, not a prompt-level request: the LLM call is never even
// constructed when retrieval comes back empty, so there is no code path where the
// model can fabricate an answer or a citation.

import { embedText } from "./embeddings/embed";
import { hedgeSynthesizedAnswer } from "./tools/inconsistencyFlagger";

export interface QaCitation {
	sourcePath: string;
	heading: string | null;
	/** Cosine similarity score for this chunk against the question embedding. */
	score: number;
}

export type QaStatus = "answered" | "no_match";

export interface QaResponse {
	question: string;
	answer: string;
	citations: QaCitation[];
	/** Null when status is "no_match" — there is nothing to score a confidence against. */
	confidence: number | null;
	status: QaStatus;
}

export interface QaEnv {
	AI: Ai;
	VECTORIZE_INDEX: Vectorize;
	QA_LLM_MODEL?: string;
}

const DEFAULT_LLM_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";

const TOP_K = 5;

/**
 * Similarity floor for treating a Vectorize match as real support for an answer.
 *
 * Chosen at 0.68 rather than the commonly-cited 0.75+ "high confidence" band because
 * these are short, single-topic note chunks (not long documents), where an on-topic
 * match against bge-base-en-v1.5 often lands in the 0.65-0.75 range even for a clearly
 * relevant chunk — a stricter threshold would push real, relevant hits into the
 * not-found path. 0.68 is deliberately still above the range where keyword-adjacent
 * but off-topic notes tend to cluster (typically < 0.6 in manual spot checks), so it
 * favors precision over recall for a sensitive-content QA surface: a false "no match"
 * is safe (the honest not-found path), a false match risks citing the wrong record.
 */
const SIMILARITY_THRESHOLD = 0.68;

const NO_MATCH_ANSWER =
	"I can't find anything in the indexed suxvault content that answers this question. No source was found, so I'm not going to guess.";

function buildNoMatchResponse(question: string): QaResponse {
	return { question, answer: NO_MATCH_ANSWER, citations: [], confidence: null, status: "no_match" };
}

/**
 * Builds the exact (and only) context the LLM will see: the retrieved chunks' text,
 * each labeled with its source path, and nothing else. No system-level general
 * knowledge, no live fetch, no prior conversation — just this string.
 */
function buildContextOnlyPrompt(question: string, chunks: { sourcePath: string; heading: string | null; text: string }[]): string {
	const passages = chunks
		.map((c, i) => `[Passage ${i + 1}] source: ${c.sourcePath}${c.heading ? ` (${c.heading})` : ""}\n${c.text}`)
		.join("\n\n");

	return [
		"You are a citation-constrained assistant. You may ONLY use the passages below to answer.",
		"Do not use any outside or general knowledge. For every claim you make, say which passage",
		"number backs it (e.g. \"(Passage 2)\"). If the passages don't cover part of the question,",
		"say explicitly that it isn't covered by the provided passages instead of guessing.",
		"",
		"--- PASSAGES ---",
		passages,
		"--- END PASSAGES ---",
		"",
		`Question: ${question}`,
	].join("\n");
}

export async function askQuestion(question: string, env: QaEnv): Promise<QaResponse> {
	const questionVector = await embedText(env.AI, question);

	const matches = await env.VECTORIZE_INDEX.query(questionVector, {
		topK: TOP_K,
		returnMetadata: "all",
	});

	const relevant = matches.matches.filter((m) => m.score >= SIMILARITY_THRESHOLD);

	// Hard constraint: no relevant retrieval → no LLM call, ever. The rest of this
	// function's LLM-calling branch is simply unreachable when `relevant` is empty.
	if (relevant.length === 0) return buildNoMatchResponse(question);

	const chunks = relevant.map((m) => ({
		sourcePath: String(m.metadata?.sourcePath ?? ""),
		heading: m.metadata?.heading ? String(m.metadata.heading) : null,
		text: String(m.metadata?.text ?? ""),
		score: m.score,
	}));

	// Every chunk that reaches the LLM must carry a real source path — this is the
	// same "no vector without a citation" guarantee from the indexing side, checked
	// again here in case older/malformed vectors ever land in the index.
	const citableChunks = chunks.filter((c) => c.sourcePath.length > 0);
	if (citableChunks.length === 0) return buildNoMatchResponse(question);

	const prompt = buildContextOnlyPrompt(question, citableChunks);
	const model = env.QA_LLM_MODEL ?? DEFAULT_LLM_MODEL;

	const result = await env.AI.run(model, {
		messages: [{ role: "user", content: prompt }],
	});
	const rawAnswer = (result as { response?: string }).response?.trim();

	if (!rawAnswer) return buildNoMatchResponse(question);

	const topScore = citableChunks[0].score;
	const hedged = hedgeSynthesizedAnswer(rawAnswer, topScore);

	return {
		question,
		answer: hedged.text,
		citations: citableChunks.map((c) => ({ sourcePath: c.sourcePath, heading: c.heading, score: c.score })),
		confidence: hedged.confidence,
		status: "answered",
	};
}

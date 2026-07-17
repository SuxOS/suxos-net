// Citation integrity check over abstract structured records — not any real personal
// content. Unlike inconsistencyFlagger.ts, this is NOT a hedged/interpretive check:
// whether a citation id exists in the known citation set is a plain structural fact
// about the data, not a claim about the world, so plain "missing citation" wording is
// correct here rather than a violation of the hedged-language pattern used elsewhere
// in src/tools/.

/**
 * Any record shape carrying citation ids — the field may be named `citationIds`
 * (as in `navigator.ts`'s `NavigatorEntry`) or `citations` (as in
 * `inconsistencyFlagger.ts`'s `Claim`). Both are accepted so this one checker covers
 * every citation-bearing shape in this codebase without a shape-specific adapter.
 */
export type CitationBearingRecord = { id: string } & ({ citationIds: string[] } | { citations: string[] });

export interface DanglingCitation {
	recordId: string;
	citationId: string;
}

export interface CitationIntegrityReport {
	/** Every dangling citation reference found, in record order. */
	dangling: DanglingCitation[];
	/** True when every citation reference in every record resolves to a known id. */
	clean: boolean;
	recordsChecked: number;
	citationReferencesChecked: number;
}

function citationIdsOf(record: CitationBearingRecord): string[] {
	if ("citationIds" in record) return record.citationIds;
	return record.citations;
}

/**
 * Walk every record and flag any citation id it references that is not present in
 * `knownCitationIds` — i.e. catch dangling/broken citation links before a reader ever
 * sees a claim that silently points at nothing. This is a bounded structural check:
 * the citation id either exists in the known set or it doesn't, so the output is
 * plain fact about the data ("missing citation: {id}"), not an interpretive claim
 * about the record's content.
 *
 * Pure function, no I/O. `knownCitationIds` is whatever the caller considers the
 * authoritative citation set (e.g. every citation actually present in the vault) —
 * this function doesn't fetch or infer it.
 */
export function checkCitationIntegrity(
	records: CitationBearingRecord[],
	knownCitationIds: string[],
): CitationIntegrityReport {
	const known = new Set(knownCitationIds);
	const dangling: DanglingCitation[] = [];
	let citationReferencesChecked = 0;

	for (const record of records) {
		for (const citationId of citationIdsOf(record)) {
			citationReferencesChecked++;
			if (!known.has(citationId)) {
				dangling.push({ recordId: record.id, citationId });
			}
		}
	}

	return {
		dangling,
		clean: dangling.length === 0,
		recordsChecked: records.length,
		citationReferencesChecked,
	};
}

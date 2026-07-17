// FICTIONAL DEMO DATA — not the user's real information. Do not treat as real.
//
// This entire file is invented content for a made-up persona ("Jordan Rivers") used to
// demonstrate the navigator/inconsistencyFlagger/citationIntegrity pipeline end-to-end
// without touching suxvault (which stays deliberately empty — design doc §1/§5).
// Every name, date, event, claim, citation id, and drug name below is fabricated.
// None of it resembles the actual user's real history, medications, or providers.

import type { StructuredRecord } from "../tools/verbositySummarizer";
import type { Claim, TrustedReference } from "../tools/inconsistencyFlagger";
import type { CitationBearingRecord } from "../tools/citationIntegrity";

export const DEMO_PERSONA_NAME = "Jordan Rivers";

/**
 * Timeline records in the shape navigator.ts / verbositySummarizer.ts expect. Spans a
 * few fictional years. All dates, events, and citation ids are invented.
 */
export const demoRecords: StructuredRecord[] = [
	{
		id: "demo-rec-001",
		date: "2022-02-14",
		text: "Jordan Rivers had an initial consult at the fictional Riverbend Clinic. Chief complaint was recurring fictional-symptom-A. No fictional-condition-X noted at this visit.",
		citations: ["demo-cite-001"],
	},
	{
		id: "demo-rec-002",
		date: "2022-05-03",
		text: "Follow-up visit. Fictional-symptom-A described as improved. Provider started a trial of Fictoprazine 10mg, a wholly invented placeholder medication.",
		citations: ["demo-cite-002", "demo-cite-003"],
	},
	{
		id: "demo-rec-003",
		date: "2022-09-21",
		text: "Fictional lab panel (Panel Q, invented) came back within the fictional reference range. No action taken.",
		citations: ["demo-cite-004"],
	},
	{
		id: "demo-rec-004",
		date: "2023-01-11",
		text: "Jordan reported a new fictional-symptom-B during a fictional telehealth visit. Provider ordered fictional imaging study (Scan Type Z, invented).",
		citations: ["demo-cite-005"],
	},
	{
		id: "demo-rec-005",
		date: "2023-01-25",
		text: "Fictional imaging study (Scan Type Z) results reviewed: unremarkable, per the fictional radiology summary.",
		citations: ["demo-cite-006"],
	},
	{
		id: "demo-rec-006",
		date: "2023-06-30",
		text: "Dosage of Fictoprazine increased to 20mg following a fictional case-conference discussion. Jordan tolerated the change well per the fictional nursing note.",
		citations: ["demo-cite-002", "demo-cite-007"],
	},
	{
		id: "demo-rec-007",
		date: "2023-11-08",
		text: "Annual fictional wellness visit. All fictional vitals within the invented normal range for this demo dataset.",
		citations: ["demo-cite-008"],
	},
	{
		id: "demo-rec-008",
		date: "2024-03-17",
		text: "Jordan started a second fictional medication, Xelbutanol, for an unrelated invented condition (fictional-condition-Y).",
		citations: ["demo-cite-009", "demo-cite-010"],
	},
	{
		id: "demo-rec-009",
		date: "2024-08-02",
		text: "Fictional care-team note: no interaction concerns flagged between Fictoprazine and Xelbutanol at this visit, per the treating fictional clinician.",
		citations: ["demo-cite-011"],
	},
	{
		id: "demo-rec-010",
		date: "2025-04-19",
		text: "Fictional follow-up: Jordan Rivers reports fictional-symptom-A fully resolved. Fictoprazine tapered per the fictional care plan.",
		citations: ["demo-cite-002"],
	},
];

/**
 * Claims in the shape inconsistencyFlagger.ts expects. Includes one intentionally
 * conflicting pair (demo-claim-conflict-a / -b) and one well-corroborated claim
 * (demo-claim-grounded) with 2+ independent fictional citations.
 */
export const demoClaims: Claim[] = [
	{
		id: "demo-claim-conflict-a",
		text: "Jordan Rivers was present at the fictional Riverbend Clinic on the fictional visit date for the fictional wellness check.",
		citations: ["demo-cite-008"],
	},
	{
		id: "demo-claim-conflict-b",
		text: "Jordan Rivers was not present at the fictional Riverbend Clinic on the fictional visit date for the fictional wellness check.",
		citations: ["demo-cite-012"],
	},
	{
		id: "demo-claim-grounded",
		text: "The dosage increase was well tolerated, corroborated by an invented nursing note and a separate invented case-conference summary.",
		citations: ["demo-cite-002", "demo-cite-007"],
	},
	{
		id: "demo-claim-unrelated",
		text: "A completely unrelated fictional lab panel from a different invented visit came back within range.",
		citations: ["demo-cite-004"],
	},
];

/**
 * A small, explicitly human-curated set of trusted references for flagAgainstReferences
 * to check demoClaims against. Modeled structurally on a drug-interaction reference
 * lookup, but "Fictoprazine", "Xelbutanol", and the fictional metabolic pathway below
 * are entirely invented — not real drug names, not real pharmacology.
 */
export const demoTrustedReferences: TrustedReference[] = [
	{
		id: "demo-ref-001",
		text: "Fictoprazine is metabolized by the fictional Pathway-Q and interacts with fictional Pathway-Q inhibitors.",
		source: "FICTIONAL-TEST Formulary Reference, invented edition",
		sourceUrl: "https://example.invalid/fictional-formulary/fictoprazine",
	},
	{
		id: "demo-ref-002",
		text: "Xelbutanol has no known fictional interaction with fictional Pathway-Q inhibitors.",
		source: "FICTIONAL-TEST Formulary Reference, invented edition",
		sourceUrl: "https://example.invalid/fictional-formulary/xelbutanol",
	},
	{
		id: "demo-ref-003",
		text: "Fictional-condition-X is not associated with fictional-symptom-B in the invented reference literature used for this demo.",
		source: "FICTIONAL-TEST Clinical Reference Manual, invented edition",
	},
];

/**
 * A claim that deliberately conflicts with demo-ref-001 above, so flagAgainstReferences
 * has something concrete to find in the demo. Fictional drug/pathway names only.
 */
export const demoClaimAgainstReference: Claim = {
	id: "demo-claim-vs-reference",
	text: "Fictoprazine is not metabolized by the fictional Pathway-Q and has a strong interaction with fictional Pathway-Q inhibitors.",
	citations: ["demo-cite-013"],
};

export const demoClaimsForReferenceCheck: Claim[] = [...demoClaims, demoClaimAgainstReference];

/** Every citation id actually referenced anywhere in the demo dataset above. */
const REFERENCED_CITATION_IDS = new Set<string>([
	...demoRecords.flatMap((r) => r.citations),
	...demoClaims.flatMap((c) => c.citations),
	...demoClaimAgainstReference.citations,
]);

/**
 * The "known" citation set for checkCitationIntegrity — every citation id the demo
 * dataset above actually resolves, MINUS one deliberately omitted id
 * ("demo-cite-012", cited by demo-claim-conflict-b) so the /demo/flags route has a
 * real dangling citation to demonstrate the integrity checker on, rather than only
 * ever showing an empty "all clean" result.
 */
export const demoKnownCitationIds: string[] = [...REFERENCED_CITATION_IDS].filter((id) => id !== "demo-cite-012");

/** All demo records + claims combined into the shape checkCitationIntegrity expects. */
export const demoCitationBearingRecords: CitationBearingRecord[] = [
	...demoRecords.map((r) => ({ id: r.id, citations: r.citations })),
	...demoClaims.map((c) => ({ id: c.id, citations: c.citations })),
	{ id: demoClaimAgainstReference.id, citations: demoClaimAgainstReference.citations },
];

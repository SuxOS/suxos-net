// Demo-only seed data for the trusted-reference curation mechanism
// (src/tools/trustedReferenceStore.ts). Modeled structurally on a drug-interaction
// reference lookup, but "Fictoprazine", "Xelbutanol", and the fictional metabolic
// pathway below are entirely invented — not real drug names, not real pharmacology.
// See demoData.ts's top-of-file disclaimer. Feeds /demo/flags's referenceConsistency
// check (via toTrustedReferences) and the read-only /demo/references route.

import { createTrustedReferenceStore, toTrustedReferences, type TrustedReferenceStore } from "../tools/trustedReferenceStore";

const NOTICE = "FICTIONAL DEMO DATA — not the user's real information. Do not treat as real.";
const SEED_TIME = "2026-01-01T00:00:00.000Z";
const DEMO_CURATOR = "demo-curator@example.invalid";

function seedDemoTrustedReferenceStore(): TrustedReferenceStore {
	const store = createTrustedReferenceStore();

	store.add(
		{
			fact: "Fictoprazine is metabolized by the fictional Pathway-Q and interacts with fictional Pathway-Q inhibitors.",
			source: "FICTIONAL-TEST Formulary Reference, invented edition",
			sourceUrl: "https://example.invalid/fictional-formulary/fictoprazine",
			curator: DEMO_CURATOR,
			scopeOfApplicability: ["health"],
		},
		SEED_TIME,
	);

	store.add(
		{
			fact: "Xelbutanol has no known fictional interaction with fictional Pathway-Q inhibitors.",
			source: "FICTIONAL-TEST Formulary Reference, invented edition",
			sourceUrl: "https://example.invalid/fictional-formulary/xelbutanol",
			curator: DEMO_CURATOR,
			scopeOfApplicability: ["health"],
		},
		SEED_TIME,
	);

	store.add(
		{
			fact: "Fictional-condition-X is not associated with fictional-symptom-B in the invented reference literature used for this demo.",
			source: "FICTIONAL-TEST Clinical Reference Manual, invented edition",
			curator: DEMO_CURATOR,
			scopeOfApplicability: ["health"],
		},
		SEED_TIME,
	);

	return store;
}

export const demoTrustedReferenceStore = seedDemoTrustedReferenceStore();

/** The sanctioned adapter output — every consumer of demo trusted references (e.g. demoFlags.ts) uses this, never the raw store. */
export const demoTrustedReferences = toTrustedReferences(demoTrustedReferenceStore);

export interface DemoReferencesView {
	references: ReturnType<TrustedReferenceStore["list"]>;
	notice: string;
}

export function buildDemoReferencesView(): DemoReferencesView {
	return { references: demoTrustedReferenceStore.list(), notice: NOTICE };
}

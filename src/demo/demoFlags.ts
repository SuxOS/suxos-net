// Demo-only aggregation of the inconsistencyFlagger + citationIntegrity tools over
// demoData.ts's fictional dataset, for the /demo/flags route. Not real content — see
// demoData.ts's top-of-file disclaimer.

import { findInconsistencies, findGroundingSignals, flagAgainstReferences } from "../tools/inconsistencyFlagger";
import { checkCitationIntegrity } from "../tools/citationIntegrity";
import { loadDemoTrustedReferences } from "./demoReferences";
import {
	demoClaimsForReferenceCheck,
	demoClaims,
	demoCitationBearingRecords,
	demoKnownCitationIds,
} from "./demoData";

const NOTICE = "FICTIONAL DEMO DATA — not the user's real information. Do not treat as real.";

// #65: /demo/flags now checks against the real curated-reference store (KV-backed,
// #19) instead of the hardcoded demoTrustedReferences array — falling back to that
// fictional array only when the store is empty, so a fresh deploy isn't blank.
export async function buildDemoFlagsView(kv: KVNamespace) {
	const selfConsistency = findInconsistencies(demoClaims);
	const trustedReferences = await loadDemoTrustedReferences(kv);
	return {
		selfConsistency,
		groundingSignals: findGroundingSignals(demoClaims, selfConsistency),
		referenceConsistency: flagAgainstReferences(demoClaimsForReferenceCheck, trustedReferences),
		citationIntegrity: checkCitationIntegrity(demoCitationBearingRecords, demoKnownCitationIds),
		notice: NOTICE,
	};
}

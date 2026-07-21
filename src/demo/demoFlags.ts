// Demo-only aggregation of the inconsistencyFlagger + citationIntegrity tools over
// demoData.ts's fictional dataset, for the /demo/flags route. Not real content — see
// demoData.ts's top-of-file disclaimer.

import { findInconsistencies, findGroundingSignals, flagAgainstReferences } from "../tools/inconsistencyFlagger";
import { checkCitationIntegrity } from "../tools/citationIntegrity";
import {
	demoClaimsForReferenceCheck,
	demoClaims,
	demoCitationBearingRecords,
	demoKnownCitationIds,
	demoTrustedReferences,
} from "./demoData";

const NOTICE = "FICTIONAL DEMO DATA — not the user's real information. Do not treat as real.";

export function buildDemoFlagsView() {
	const selfConsistency = findInconsistencies(demoClaims);
	return {
		selfConsistency,
		groundingSignals: findGroundingSignals(demoClaims, selfConsistency),
		referenceConsistency: flagAgainstReferences(demoClaimsForReferenceCheck, demoTrustedReferences),
		citationIntegrity: checkCitationIntegrity(demoCitationBearingRecords, demoKnownCitationIds),
		notice: NOTICE,
	};
}

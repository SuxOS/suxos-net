// Demo-only seed data for the access-scoping mechanism (src/access/accessScopes.ts),
// exposed at /demo/access/whoami behind the ACCESS_SCOPING_ENABLED flag (src/index.ts).
// Fictional recipients for the Jordan Rivers demo persona only — no real recipients or
// scopes are defined anywhere in this codebase. See demoData.ts's disclaimer.

import { createAccessScopeStore, type AccessScopeStore, type RecordScope } from "../access/accessScopes";

const NOTICE = "FICTIONAL DEMO DATA — not the user's real information. Do not treat as real.";
const SEED_TIME = "2026-01-01T00:00:00.000Z";

function seedDemoAccessScopeStore(): AccessScopeStore {
	const store = createAccessScopeStore();

	const careTeam = store.issueInvite("demo-care-team@example.invalid", ["health"], SEED_TIME);
	store.redeemInvite(careTeam.id, SEED_TIME);

	const attorney = store.issueInvite("demo-attorney@example.invalid", ["legal"], SEED_TIME);
	store.redeemInvite(attorney.id, SEED_TIME);

	const family = store.issueInvite("demo-family@example.invalid", ["general"], SEED_TIME);
	store.redeemInvite(family.id, SEED_TIME);

	// demo-unknown@example.invalid is deliberately never invited, to demonstrate
	// default-deny for an identity the mechanism has never heard of.
	return store;
}

export const demoAccessScopeStore = seedDemoAccessScopeStore();

export interface DemoAccessWhoamiView {
	identity: string;
	scopes: RecordScope[];
	notice: string;
}

export function buildDemoAccessWhoamiView(identity: string): DemoAccessWhoamiView {
	return { identity, scopes: demoAccessScopeStore.scopesForIdentity(identity), notice: NOTICE };
}

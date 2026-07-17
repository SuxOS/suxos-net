// Per-recipient invite + access-scoping layer (issue: per-recipient invites +
// access-scoping). Additive, feature-flagged (see ACCESS_SCOPING_ENABLED in
// src/index.ts) and strictly layered on top of — never a replacement for — the
// existing Cloudflare Access identity gate (assertStagingAccess in src/index.ts).
//
// Default-deny is load-bearing: an identity with no redeemed invite grant sees zero
// scopes. There is no "sees everything" fallback anywhere in this module.

export type RecordScope = "health" | "legal" | "financial" | "general";

export const RECORD_SCOPE_VALUES: readonly RecordScope[] = ["health", "legal", "financial", "general"];

export function isRecordScope(value: string): value is RecordScope {
	return (RECORD_SCOPE_VALUES as readonly string[]).includes(value);
}

export interface Invite {
	id: string;
	recipientId: string;
	scopes: RecordScope[];
	createdAt: string;
	/** null until the recipient redeems it — an unredeemed invite grants no scopes. */
	redeemedAt: string | null;
}

export interface AccessScopeStore {
	issueInvite(recipientId: string, scopes: RecordScope[], now: string): Invite;
	redeemInvite(inviteId: string, now: string): Invite;
	listInvites(): Invite[];
	/** Default-deny: returns an empty array for any identity with no redeemed invite. */
	scopesForIdentity(identity: string): RecordScope[];
	hasScope(identity: string, scope: RecordScope): boolean;
}

/**
 * In-memory, per-Worker-isolate access-scope store. Matches this codebase's existing
 * "pure store, no external I/O" pattern (see src/tools/*.ts) rather than introducing a
 * new persistence layer for a mechanism that has no real recipients yet.
 */
export function createAccessScopeStore(): AccessScopeStore {
	const invites = new Map<string, Invite>();
	let nextId = 1;

	function scopesForIdentity(identity: string): RecordScope[] {
		const scopes = new Set<RecordScope>();
		for (const invite of invites.values()) {
			if (invite.recipientId === identity && invite.redeemedAt !== null) {
				for (const scope of invite.scopes) scopes.add(scope);
			}
		}
		return [...scopes];
	}

	return {
		issueInvite(recipientId, scopes, now) {
			if (scopes.length === 0) throw new Error("an invite must grant at least one scope");
			const invite: Invite = {
				id: `invite-${nextId++}`,
				recipientId,
				scopes: [...scopes],
				createdAt: now,
				redeemedAt: null,
			};
			invites.set(invite.id, invite);
			return invite;
		},
		redeemInvite(inviteId, now) {
			const invite = invites.get(inviteId);
			if (!invite) throw new Error(`unknown invite: ${inviteId}`);
			if (invite.redeemedAt !== null) throw new Error(`invite already redeemed: ${inviteId}`);
			const redeemed: Invite = { ...invite, redeemedAt: now };
			invites.set(inviteId, redeemed);
			return redeemed;
		},
		listInvites() {
			return [...invites.values()];
		},
		scopesForIdentity,
		hasScope(identity, scope) {
			return scopesForIdentity(identity).includes(scope);
		},
	};
}

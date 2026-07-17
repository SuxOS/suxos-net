/**
 * Identity extension point for the per-individual audit log (#20/#23 — not yet
 * merged as of this PR; `git log`/open PRs show no audit-log implementation on
 * main). Whichever mechanism authenticated a request should resolve to one of these
 * before being written to the audit log, so the log always records a real per-
 * individual identity rather than a shared/anonymous one (design doc §5, issue #18
 * acceptance: "their username shows up as the identity in the audit log").
 *
 * - `operator-access-email`: the existing Cloudflare-Access-authenticated operator
 *   identity (today, the ACCESS_STAGING_IDENTITY stand-in; in production, the real
 *   Access-verified email).
 * - `recipient-username`: a recipient authenticated via the username/password system
 *   added in this PR — see src/auth/session.ts / src/auth/store.ts.
 *
 * When the audit log lands, its write path should accept `AuditIdentity` (or a
 * structurally-equivalent type) rather than a bare string, so it's impossible to log
 * an identity without also recording which mechanism produced it.
 */
export type AuditIdentity = { kind: "operator-access-email"; email: string } | { kind: "recipient-username"; username: string };

export function operatorIdentity(email: string): AuditIdentity {
	return { kind: "operator-access-email", email };
}

export function recipientIdentity(username: string): AuditIdentity {
	return { kind: "recipient-username", username };
}

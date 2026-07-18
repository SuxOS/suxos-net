/**
 * Read-only admin view of the access-audit log (#20 acceptance criterion). Same
 * operator-bearer-token gate as the other /admin/* routes (src/auth/routes.ts) — no
 * separate credential to provision, and no self-serve access to this trail either.
 */

import { assertOperator, type AuthEnv } from "../auth/routes";
import { listAuditLog } from "./log";

export type AuditEnv = AuthEnv;

function methodNotAllowed(allow: string): Response {
	return Response.json({ error: `method not allowed, expected ${allow}` }, { status: 405, headers: { Allow: allow } });
}

/** GET /admin/audit-log?cursor=... — operator-only, paginated, oldest-first. */
export async function handleAuditLogAdmin(request: Request, env: AuditEnv): Promise<Response> {
	if (request.method !== "GET") return methodNotAllowed("GET");

	const denied = await assertOperator(request, env);
	if (denied) return denied;

	const url = new URL(request.url);
	const cursor = url.searchParams.get("cursor") ?? undefined;
	const result = await listAuditLog(env.NAV_CACHE, undefined, cursor);
	return Response.json(result);
}

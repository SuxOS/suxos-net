import { askQuestion } from "./qa";
import { getNavigatorView, isTimeScope, isVerbosity } from "./navigator";

export interface Env {
	NAV_CACHE: KVNamespace;
	STAGING: string;
	ACCESS_STAGING_IDENTITY: string;
}

// TODO: real Cloudflare Access policy (per-recipient OAuth invites) is deferred —
// design doc §4/§5. This staging Worker has no Access edge in `wrangler dev`; treat
// every request as authenticated as ACCESS_STAGING_IDENTITY, matching the one shared
// test/dev identity the design doc calls for tonight.
function assertStagingAccess(env: Env): void {
	if (env.STAGING !== "1") {
		throw new Error("suxos-net is staging-only; refusing to run without STAGING=1");
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		assertStagingAccess(env);
		const url = new URL(request.url);

		if (url.pathname === "/api/navigator") {
			const verbosity = url.searchParams.get("verbosity") ?? "oneline";
			const timeScope = url.searchParams.get("timeScope") ?? "week";
			if (!isVerbosity(verbosity) || !isTimeScope(timeScope)) {
				return Response.json({ error: "invalid verbosity or timeScope" }, { status: 400 });
			}
			return Response.json(getNavigatorView(verbosity, timeScope));
		}

		if (url.pathname === "/api/qa" && request.method === "POST") {
			const body = await request.json<{ question?: string }>().catch(() => ({}) as { question?: string });
			if (!body.question) {
				return Response.json({ error: "missing question" }, { status: 400 });
			}
			return Response.json(askQuestion(body.question));
		}

		if (url.pathname === "/healthz") {
			return Response.json({ ok: true, staging: true, identity: env.ACCESS_STAGING_IDENTITY });
		}

		return new Response("not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;

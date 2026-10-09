import { ingestCronHandler } from "@kalypso/server";
import { serve } from "../../../../lib/server/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The pass stops starting RPC calls after 25 s and then commits.
export const maxDuration = 60;

/** One ingest pass, for a scheduler holding `Authorization: Bearer <CRON_SECRET>`. */
export async function POST(req: Request): Promise<Response> {
  return serve("ingest", (ctx) => ingestCronHandler(req, ctx));
}

/**
 * Vercel Cron calls with GET and the same bearer header, and the handler
 * takes POST only, so the GET is passed on as a POST with the same headers.
 * The handler never reads a body, and a browser cannot set that header on a
 * cross-site GET, so this opens nothing a POST does not.
 */
export async function GET(req: Request): Promise<Response> {
  return serve("ingest", (ctx) => ingestCronHandler(new Request(req.url, { method: "POST", headers: req.headers }), ctx));
}

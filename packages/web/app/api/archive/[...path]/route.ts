import { archiveHandler } from "@kalypso/server";
import { serve } from "../../../../lib/server/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A read may first run a bounded catch-up against RPC, whose calls wait up to 10 s each.
export const maxDuration = 60;

/** The archive's read API: /api/archive/v1/health, the /v1 token and payroll routes, and /contracts/{id}/events. */
export async function GET(req: Request): Promise<Response> {
  return serve("archive", (ctx) => archiveHandler(req, ctx));
}

/** The handler answers cross-origin preflight itself, so other sites' wallets can read the archive. */
export async function OPTIONS(req: Request): Promise<Response> {
  return serve("archive", (ctx) => archiveHandler(req, ctx));
}

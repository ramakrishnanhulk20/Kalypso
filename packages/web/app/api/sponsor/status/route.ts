import { sponsorStatusHandler } from "@kalypso/server";
import { serve } from "../../../../lib/server/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The Channels lookup alone may wait 10 s.
export const maxDuration = 60;

/** GET /api/sponsor/status?id=<transactionId>: `{ status, hash }`, or the handler's `{ error: code }`. */
export async function GET(req: Request): Promise<Response> {
  return serve("sponsorStatus", (ctx) => sponsorStatusHandler(req, ctx));
}

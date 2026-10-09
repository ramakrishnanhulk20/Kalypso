import { sponsorHandler } from "@kalypso/server";
import { serve } from "../../../lib/server/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Simulation and the relay each wait up to 10 s, so one request can outlast
// a 10 s platform default and be cut off after the relay was sent.
export const maxDuration = 60;

/** Pays the network fee for a worker's own action. Every refusal is the handler's own `{ error: code }`. */
export async function POST(req: Request): Promise<Response> {
  return serve("sponsor", (ctx) => sponsorHandler(req, ctx));
}

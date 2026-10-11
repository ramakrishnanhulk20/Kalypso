import { faucetHandler } from "@kalypso/server";
import { serve } from "../../../lib/server/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A claim reads the ledger (up to 10 s), sends (up to 10 s), then waits up to 25 s for the ledger.
export const maxDuration = 60;

/** POST /api/faucet with `{ address, asset }`: `{ hash, asset, amount }` once the payout is on chain, or the handler's `{ error: code }`. */
export async function POST(req: Request): Promise<Response> {
  return serve("faucet", (ctx) => faucetHandler(req, ctx));
}

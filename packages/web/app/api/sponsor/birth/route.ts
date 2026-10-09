import { walletBirthRecordHandler } from "@kalypso/server";
import { serve } from "../../../../lib/server/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The RPC read alone may wait 10 s.
export const maxDuration = 60;

/** POST /api/sponsor/birth with `{ address, hash }`: `{ recorded: true }`, or the handler's `{ error: code }`. */
export async function POST(req: Request): Promise<Response> {
  return serve("sponsorBirth", (ctx) => walletBirthRecordHandler(req, ctx));
}

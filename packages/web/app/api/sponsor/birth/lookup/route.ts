import { walletBirthLookupHandler } from "@kalypso/server";
import { serve } from "../../../../../lib/server/context";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** POST /api/sponsor/birth/lookup with `{ address }`: `{ hash }` (null when none is stored), or the handler's `{ error: code }`. */
export async function POST(req: Request): Promise<Response> {
  return serve("sponsorBirthLookup", (ctx) => walletBirthLookupHandler(req, ctx));
}

import { TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import type { Config } from "../config.ts";
import { OutboundError, fetchWithTimeout, parseJsonBytes } from "../http.ts";
import { MAX_ENVELOPE_CHARS, type RpcTransactionReader } from "../rpc.ts";

const MAX_SEND_REPLY_BYTES = 64 * 1024;
const MAX_READ_REPLY_BYTES = 512 * 1024;
const SEND_ID = 1;
const READ_ID = 2;

const sendReply = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.literal(SEND_ID),
  result: z.object({
    status: z.enum(["PENDING", "DUPLICATE", "TRY_AGAIN_LATER", "ERROR"]),
    hash: z.string().regex(/^[0-9a-f]{64}$/),
    errorResultXdr: z.string().max(4_096).optional(),
  }),
});

export type SendOutcome =
  /** In core's queue: it may land. */
  | { kind: "accepted" }
  /** Core turned it away before its queue (TRY_AGAIN_LATER, or ERROR with this result code): it can never land. */
  | { kind: "refused"; reason: string }
  /** No answer we can read: it may have reached core. */
  | { kind: "unknown"; reason: string };

function resultCodeOf(errorResultXdr: string | undefined): string {
  if (errorResultXdr === undefined) return "unreadable";
  try {
    return xdr.TransactionResult.fromXDR(errorResultXdr, "base64").result().switch().name;
  } catch {
    return "unreadable";
  }
}

/**
 * Hands one signed payout to RPC's sendTransaction. It lives with the faucet, not in the shared
 * RPC client, so no other code on the server has a ready way to submit a transaction. It goes out
 * through fetchWithTimeout to the configured RPC_URL like every outbound call (C22), ends by the
 * claim's `deadline` at the latest, and never throws: anything but a well-formed reply about this
 * exact hash is "unknown", because only core's own refusal proves the payout cannot land.
 */
export async function sendPayout(
  cfg: Pick<Config, "RPC_URL" | "CHANNELS_URL">,
  envelope: string,
  hash: string,
  deadline: AbortSignal,
  fetchImpl?: typeof fetch,
): Promise<SendOutcome> {
  let res;
  try {
    res = await fetchWithTimeout(
      cfg,
      "RPC_URL",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: SEND_ID, method: "sendTransaction", params: { transaction: envelope } }),
        maxResponseBytes: MAX_SEND_REPLY_BYTES,
        signal: deadline,
      },
      fetchImpl,
    );
  } catch (err) {
    return { kind: "unknown", reason: err instanceof OutboundError ? err.failure : "network" };
  }
  if (res.status !== 200) return { kind: "unknown", reason: "http " + res.status };
  let payload: unknown;
  try {
    payload = parseJsonBytes(res.body);
  } catch {
    return { kind: "unknown", reason: "not json" };
  }
  const reply = sendReply.safeParse(payload);
  if (!reply.success) return { kind: "unknown", reason: "bad reply" };
  const { status, hash: named, errorResultXdr } = reply.data.result;
  if (named !== hash) return { kind: "unknown", reason: "another hash" };
  if (status === "PENDING" || status === "DUPLICATE") return { kind: "accepted" };
  if (status === "TRY_AGAIN_LATER") return { kind: "refused", reason: "try_again_later" };
  return { kind: "refused", reason: resultCodeOf(errorResultXdr) };
}

export type Confirmation = { kind: "success"; ledger: number } | { kind: "failed" } | { kind: "unknown" };

const failureReply = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.literal(READ_ID),
  result: z.object({
    status: z.literal("FAILED"),
    envelopeXdr: z.string().min(1).max(MAX_ENVELOPE_CHARS),
    resultXdr: z.string().min(1).max(4_096),
  }),
});

/**
 * Why a payout that RPC reported FAILED failed: the result code of its one operation (for example
 * paymentNoTrust or createAccountAlreadyExist), or the transaction's own code when no operation
 * ran (for example txBadSeq). Read here, not through the shared RPC client, which keeps only a
 * transaction's status, envelope and ledger. Null when the read fails, ends at the claim's
 * `deadline`, or its reply does not prove it is about this payout; the caller then treats the
 * cause as unknown. Never throws.
 */
export async function failureCodeOf(
  cfg: Pick<Config, "RPC_URL" | "CHANNELS_URL">,
  hash: string,
  passphrase: string,
  deadline: AbortSignal,
  fetchImpl?: typeof fetch,
): Promise<string | null> {
  let res;
  try {
    res = await fetchWithTimeout(
      cfg,
      "RPC_URL",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: READ_ID, method: "getTransaction", params: { hash } }),
        maxResponseBytes: MAX_READ_REPLY_BYTES,
        signal: deadline,
      },
      fetchImpl,
    );
  } catch {
    return null;
  }
  if (res.status !== 200) return null;
  let payload: unknown;
  try {
    payload = parseJsonBytes(res.body);
  } catch {
    return null;
  }
  const reply = failureReply.safeParse(payload);
  if (!reply.success || !envelopeHashes(reply.data.result.envelopeXdr, hash, passphrase)) return null;
  try {
    const result = xdr.TransactionResult.fromXDR(reply.data.result.resultXdr, "base64").result();
    if (result.switch().name !== "txFailed") return result.switch().name;
    const ops = result.results();
    if (ops.length !== 1 || ops[0]!.switch().name !== "opInner") return null;
    const tr = ops[0]!.tr();
    if (tr.switch().name === "payment") return tr.paymentResult().switch().name;
    if (tr.switch().name === "createAccount") return tr.createAccountResult().switch().name;
    return null;
  } catch {
    return null;
  }
}

function envelopeHashes(envelopeXdr: string, hash: string, passphrase: string): boolean {
  try {
    return TransactionBuilder.fromXDR(envelopeXdr, passphrase).hash().toString("hex") === hash;
  } catch {
    return false;
  }
}

/**
 * Reads the payout back from the chain through getTransaction until RPC reports its outcome or the
 * claim's `deadline` aborts, which also cuts off a poll still in flight. A reply counts only when
 * its envelope hashes to `hash` on this network, so an RPC naming some other transaction can never
 * become a success, or a failure that would give the claim back. Never throws; a read that fails
 * is simply tried again.
 */
export async function confirmPayout(
  rpc: Pick<RpcTransactionReader, "getTransaction">,
  hash: string,
  passphrase: string,
  timing: { deadline: AbortSignal; pollMs: number },
): Promise<Confirmation> {
  const { deadline, pollMs } = timing;
  for (;;) {
    try {
      const found = await rpc.getTransaction(hash, deadline);
      if (found.status !== "NOT_FOUND") {
        if (!envelopeHashes(found.envelopeXdr, hash, passphrase)) return { kind: "unknown" };
        return found.status === "SUCCESS" ? { kind: "success", ledger: found.ledger } : { kind: "failed" };
      }
    } catch {
      // A read that failed says nothing about the payout.
    }
    if (deadline.aborted) return { kind: "unknown" };
    await sleep(pollMs, undefined, { signal: deadline }).catch(() => undefined);
    if (deadline.aborted) return { kind: "unknown" };
  }
}

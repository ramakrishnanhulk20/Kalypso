import { Keypair, StrKey, xdr, type Asset } from "@stellar/stellar-sdk";
import type { RpcLedgerEntries } from "../rpc.ts";

/**
 * Testnet's base reserve, 0.5 XLM. It is a network setting validators can vote to change; if it
 * rises, a payout this file thought affordable fails on chain, which the handler treats as a
 * provable failure. Nothing is ever paid twice because of it.
 */
export const BASE_RESERVE_STROOPS = 5_000_000n;

/** The trustline flag that lets an account hold and receive the asset. */
const AUTHORIZED_FLAG = 1;

export interface AccountState {
  readonly sequence: string;
  /** Native balance above the account's minimum balance and its open selling offers. */
  readonly spendableXlm: bigint;
}

export interface TrustlineState {
  readonly authorized: boolean;
  /** Balance not tied up in selling offers. */
  readonly spendable: bigint;
  /** How much more the line can receive before its limit, after open buying offers. */
  readonly room: bigint;
}

export function accountKey(account: string): string {
  return xdr.LedgerKey.account(new xdr.LedgerKeyAccount({ accountId: Keypair.fromPublicKey(account).xdrAccountId() })).toXDR("base64");
}

export function trustlineKey(account: string, asset: Asset): string {
  return xdr.LedgerKey.trustline(
    new xdr.LedgerKeyTrustLine({ accountId: Keypair.fromPublicKey(account).xdrAccountId(), asset: asset.toTrustLineXDRObject() }),
  ).toXDR("base64");
}

const int64 = (value: xdr.Int64): bigint => BigInt(value.toString());

function accountState(entry: xdr.AccountEntry): AccountState {
  let selling = 0n;
  let sponsoring = 0n;
  let sponsored = 0n;
  const ext = entry.ext();
  if (ext.switch() === 1) {
    selling = int64(ext.v1().liabilities().selling());
    if (ext.v1().ext().switch() === 2) {
      sponsoring = BigInt(ext.v1().ext().v2().numSponsoring());
      sponsored = BigInt(ext.v1().ext().v2().numSponsored());
    }
  }
  const minimum = (2n + BigInt(entry.numSubEntries()) + sponsoring - sponsored) * BASE_RESERVE_STROOPS;
  return { sequence: entry.seqNum().toString(), spendableXlm: int64(entry.balance()) - minimum - selling };
}

function trustlineState(entry: xdr.TrustLineEntry): TrustlineState {
  let buying = 0n;
  let selling = 0n;
  if (entry.ext().switch() === 1) {
    buying = int64(entry.ext().v1().liabilities().buying());
    selling = int64(entry.ext().v1().liabilities().selling());
  }
  const balance = int64(entry.balance());
  return {
    authorized: (entry.flags() & AUTHORIZED_FLAG) !== 0,
    spendable: balance - selling,
    room: int64(entry.limit()) - balance - buying,
  };
}

export interface LedgerView {
  account(id: string): AccountState | null;
  trustline(id: string, asset: Asset): TrustlineState | null;
}

/**
 * Reads RPC's reply by what each entry says it is, not by the key RPC echoes back, so an entry is
 * found only when its own account id (and asset) match what was asked, compared after the same
 * XDR encoding on both sides. An entry that does not decode is left out, so it reads as missing:
 * for the faucet's own account that refuses the claim, and for a destination it means a
 * createAccount, which fails on chain without paying anything if the account in fact exists.
 */
export function ledgerView(reply: RpcLedgerEntries): LedgerView {
  const accounts = new Map<string, AccountState>();
  const trustlines = new Map<string, TrustlineState>();
  for (const { xdr: body } of reply.entries) {
    try {
      const data = xdr.LedgerEntryData.fromXDR(body, "base64");
      if (data.switch().name === "account") {
        const entry = data.account();
        accounts.set(StrKey.encodeEd25519PublicKey(entry.accountId().ed25519()), accountState(entry));
      } else if (data.switch().name === "trustline") {
        const entry = data.trustLine();
        trustlines.set(StrKey.encodeEd25519PublicKey(entry.accountId().ed25519()) + " " + entry.asset().toXDR("base64"), trustlineState(entry));
      }
    } catch {
      continue;
    }
  }
  return {
    account: (id) => accounts.get(id) ?? null,
    trustline: (id, asset) => trustlines.get(id + " " + asset.toTrustLineXDRObject().toXDR("base64")) ?? null,
  };
}

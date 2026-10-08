// Sending and simulating transactions for the seed and the prove command. A transaction's hash
// is written to the journal before it is sent, so a crashed seed finds it again on the chain
// instead of sending a second one.
import { core, port, rpcServer, sdk, stack } from "./kalypso.mjs";

const TIMEOUT_SECONDS = 120;
// Ledger close times trail this machine's clock a little; past this margin NOT_FOUND is final.
const CLOCK_MARGIN_MS = 30_000;
// Classic operations pay at most this per operation, enough to clear testnet surge pricing.
const CLASSIC_FEE = "10000";

const firstLine = (s) => String(s ?? "").split("\n")[0].trim();

/**
 * What the chain says about a transaction: SUCCESS or FAILED with its ledger, or NOT_FOUND.
 * NOT_FOUND also comes back for a transaction older than RPC's window; `oldestLedger` tells them apart.
 */
export async function txStatus(hash) {
  const r = await rpcServer.getTransaction(hash);
  return { status: r.status, ledger: r.ledger, oldestLedger: r.oldestLedger, returnValue: r.returnValue, feeCharged: r.resultXdr?.feeCharged() };
}

/** Waits for a recorded hash until its validity window has passed. */
async function settleRecorded(prior) {
  const deadline = (prior.validUntil ?? 0) * 1000 + CLOCK_MARGIN_MS;
  for (;;) {
    const s = await txStatus(prior.hash);
    if (s.status !== "NOT_FOUND" || Date.now() > deadline) return s;
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function sendAndWait(label, tx, journal) {
  const hash = tx.hash().toString("hex");
  const validUntil = Number(tx.timeBounds.maxTime);
  journal.pending(label, { hash, validUntil });
  await port.submit(tx.toXDR());
  const res = await port.waitFor(hash, Math.max(0, validUntil * 1000 - Date.now()) + CLOCK_MARGIN_MS);
  if (res.status !== "SUCCESS") throw new Error(`${label}: transaction ${hash} ended ${res.status}`);
  const s = await txStatus(hash);
  const entry = { hash, ledger: s.ledger, feeStroops: Number(s.feeCharged?.toString() ?? 0) };
  journal.done(label, entry);
  // The value the confirmed transaction returned, as core's waitFor read it; callers decode it strictly.
  return { ...entry, returnValue: res.returnValue ?? s.returnValue, reused: false };
}

/**
 * If `label` already has a transaction on chain, returns it. A recorded transaction that failed
 * stops the seed, because a person should read why. A pending one that can no longer land
 * returns null, so it is built again. One recorded as landed is never sent again, even when
 * RPC cannot find it any more.
 */
async function recorded(label, journal) {
  const prior = journal.get(label);
  if (!prior?.hash) return null;
  const s = prior.ledger ? await txStatus(prior.hash) : await settleRecorded(prior);
  if (s.status === "SUCCESS") {
    journal.done(label, { hash: prior.hash, ledger: s.ledger, feeStroops: Number(s.feeCharged?.toString() ?? prior.feeStroops ?? 0) });
    return { hash: prior.hash, ledger: s.ledger, returnValue: s.returnValue, reused: true };
  }
  if (s.status === "FAILED") throw new Error(`${label}: recorded transaction ${prior.hash} failed on chain`);
  if (prior.ledger) {
    const why = prior.ledger < s.oldestLedger ? "is older than RPC's window" : "is not found by RPC";
    throw new Error(`${label}: transaction ${prior.hash}, recorded as landed in ledger ${prior.ledger}, ${why}, so it is not sent again`);
  }
  return null;
}

const signWith = (keypair, unsignedXdr) => {
  const tx = sdk.TransactionBuilder.fromXDR(unsignedXdr, stack.passphrase);
  tx.sign(keypair);
  return tx;
};

/**
 * One contract call signed by `signer`: build(base) returns the unsigned envelope (it may be
 * async, to build a proof), then simulate, assemble, sign, send, wait. Returns hash, ledger and
 * the return value. A call already on chain under `label` is not sent again.
 */
export async function invoke({ label, signer, build, journal }) {
  const done = await recorded(label, journal);
  if (done) return done;
  const { sequence } = await port.sourceAccount(signer.publicKey());
  const unsigned = await build({ source: { address: signer.publicKey(), sequence }, networkPassphrase: stack.passphrase, timeoutSeconds: TIMEOUT_SECONDS });
  const sim = await port.simulate(unsigned);
  if (!sim.ok) throw new Error(`${label}: simulation failed: ${firstLine(sim.error)}`);
  // The call is read back from the envelope itself, with core's decoder, to pick its fee cap.
  const call = core.decodeInvocation(unsigned, stack.passphrase);
  const isPay = call.contractId === stack.contracts.payroll && call.method === "pay";
  let assembled;
  try {
    assembled = core.assembleFromSimulation(unsigned, sim, stack.passphrase, isPay ? core.MAX_PAY_FEE_STROOPS : core.MAX_SETUP_FEE_STROOPS);
  } catch (e) {
    if (e instanceof core.FeeCapError) throw new Error(`${label}: refused before signing: ${e.message}`);
    throw e;
  }
  return sendAndWait(label, signWith(signer, assembled), journal);
}

/** One classic transaction (trustline, path payment) signed by `signer`. */
export async function classic({ label, signer, operations, journal }) {
  const done = await recorded(label, journal);
  if (done) return done;
  const { sequence } = await port.sourceAccount(signer.publicKey());
  const builder = new sdk.TransactionBuilder(new sdk.Account(signer.publicKey(), sequence), { fee: CLASSIC_FEE, networkPassphrase: stack.passphrase });
  for (const op of operations) builder.addOperation(op);
  const tx = builder.setTimeout(TIMEOUT_SECONDS).build();
  tx.sign(signer);
  return sendAndWait(label, tx, journal);
}

/**
 * Reads why a simulation failed. `contractCode` is n in Error(Contract, #n) when the call ended
 * on a contract error. `auth` is set when it ended on Error(Auth, ...): `account` is the address
 * the host refused, and `reason` is "no signature" when nobody authorised for it, or "signature
 * rejected" when an authorisation was offered and its signature did not belong to that account.
 */
export function readFailure(errorText) {
  const text = String(errorText ?? "");
  const head = firstLine(text);
  const contract = /Error\(Contract, #(\d+)\)/.exec(head);
  const authFailure = /Error\(Auth, (\w+)\)/.exec(head);
  let auth = null;
  if (authFailure) {
    const unsigned = /"Unauthorized function call for address", ([GC][A-Z2-7]{55})/.exec(text);
    const rejected = /"failed account authentication with error", ([GC][A-Z2-7]{55})/.exec(text);
    if (unsigned) auth = { reason: "no signature", account: unsigned[1], code: authFailure[1] };
    else if (rejected) auth = { reason: "signature rejected", account: rejected[1], code: authFailure[1], signerNotOnAccount: text.includes("signer does not belong to account") };
    else auth = { reason: "other", account: null, code: authFailure[1] };
  }
  return { head, contractCode: contract ? Number(contract[1]) : null, auth };
}

/**
 * Simulates one contract call from `source` without signing or sending anything.
 *
 * mode "record" lets the host collect whatever signatures the call needs, so only the
 * contract's own checks can refuse it. mode "enforce" runs the call exactly as the network
 * would with the authorisations in `auth` (none by default), signatures included.
 */
export async function simulate({ source, contractId, method, args, mode, auth = [] }) {
  let account;
  try {
    const { sequence } = await port.sourceAccount(source);
    account = new sdk.Account(source, sequence);
  } catch {
    // A brand-new key has no account yet. Simulation does not need one to exist.
    account = new sdk.Account(source, "0");
  }
  const op = new sdk.Contract(contractId).call(method, ...args);
  if (auth.length > 0) op.body().invokeHostFunctionOp().auth(auth);
  const tx = new sdk.TransactionBuilder(account, { fee: sdk.BASE_FEE, networkPassphrase: stack.passphrase }).addOperation(op).setTimeout(TIMEOUT_SECONDS).build();
  const sim = await rpcServer.simulateTransaction(tx, undefined, mode);
  // The ledger the simulation ran against, so a caller can tell whether two simulations saw the same one.
  const latestLedger = sim.latestLedger;
  if (sdk.rpc.Api.isSimulationError(sim)) return { ok: false, latestLedger, ...readFailure(sim.error) };
  if (sdk.rpc.Api.isSimulationRestore(sim)) return { ok: false, latestLedger, head: "archived state must be restored first", contractCode: null, auth: null };
  return { ok: true, latestLedger, head: "the simulation succeeded", contractCode: null, auth: null };
}

/** A journal that keeps nothing, for throwaway accounts whose transactions are never resumed. */
export const memoryJournal = () => ({ get: () => undefined, pending() {}, done() {} });

/**
 * An authorisation entry that claims to come from `claimed` for the call `method(args)` on
 * `contractId`, signed by `forger`'s own key. The host rejects it unless `forger` can sign for
 * `claimed`.
 */
export async function forgedAuthorization({ claimed, forger, contractId, method, args }) {
  const { sequence: latest } = await rpcServer.getLatestLedger();
  const unsigned = new sdk.xdr.SorobanAuthorizationEntry({
    credentials: sdk.xdr.SorobanCredentials.sorobanCredentialsAddress(
      new sdk.xdr.SorobanAddressCredentials({
        address: new sdk.Address(claimed).toScAddress(),
        nonce: new sdk.xdr.Int64(BigInt.asIntN(64, BigInt(`0x${Buffer.from(crypto.getRandomValues(new Uint8Array(8))).toString("hex")}`))),
        signatureExpirationLedger: 0,
        signature: sdk.xdr.ScVal.scvVoid(),
      }),
    ),
    rootInvocation: new sdk.xdr.SorobanAuthorizedInvocation({
      function: sdk.xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new sdk.xdr.InvokeContractArgs({ contractAddress: new sdk.Address(contractId).toScAddress(), functionName: method, args }),
      ),
      subInvocations: [],
    }),
  });
  return sdk.authorizeEntry(unsigned, forger, latest + 60, stack.passphrase);
}

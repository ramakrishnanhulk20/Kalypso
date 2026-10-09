// Covers the portal's error types: every code's sentence, and how each core, network, contract and
// browser failure maps to one, with nothing of the original text getting through.
// Does NOT cover: whether each screen shows these sentences (UI work), or the sponsor's own codes
// (sponsor.test.ts).
import { describe, expect, it } from "vitest";
import {
  AuditorBindingError,
  ContractCallError,
  DecodeError,
  FeeCapError,
  KeyError,
  PrfUnavailableError,
  RpcTimeoutError,
  SubmitRejectedError,
  WorkerActionError,
  WorkerViewError,
} from "@kalypso/core";
import { WORKER_ERROR_CODES, WorkerError, simulationRefusal, toWorkerError } from "./errors";
import { SponsorError } from "./sponsor";

const LONG_DASH = String.fromCharCode(0x2014);

describe("worker error sentences", () => {
  it("gives every code its own plain sentence with no code name, digits of money or long dash", () => {
    const seen = new Set<string>();
    for (const code of WORKER_ERROR_CODES) {
      const { message } = new WorkerError(code);
      expect(message, code).toMatch(/^[A-Z].*\.$/);
      expect(message, code).not.toContain("_");
      expect(message, code).not.toContain(LONG_DASH);
      expect(message, code).not.toMatch(/\d/);
      seen.add(message);
    }
    expect(seen.size).toBe(WORKER_ERROR_CODES.length);
  });
});

describe("toWorkerError", () => {
  const cases: [string, unknown, string][] = [
    ["no PRF", new PrfUnavailableError("MISSING"), "PRF_UNAVAILABLE"],
    ["two different signatures", new KeyError("NOT_REPRODUCIBLE"), "WALLET_NOT_REPRODUCIBLE"],
    ["a signature by another key", new KeyError("BAD_SIGNATURE"), "WALLET_SIGNATURE_INVALID"],
    ["a short signature", new KeyError("SIGNATURE_LENGTH"), "WALLET_SIGNATURE_INVALID"],
    ["a non-testnet key", new KeyError("NETWORK"), "INVALID_INPUT"],
    ["an unregistered worker view", new WorkerViewError("NOT_REGISTERED"), "NOT_REGISTERED"],
    ["foreign keys", new WorkerViewError("KEYS_MISMATCH"), "KEYS_MISMATCH"],
    ["a short balance", new WorkerActionError("INSUFFICIENT_FUNDS"), "INSUFFICIENT_FUNDS"],
    ["a history that does not open", new WorkerActionError("HISTORY_INCOMPLETE"), "HISTORY_INCOMPLETE"],
    ["an auditor id someone else owns", new AuditorBindingError("OWNER_MISMATCH"), "AUDITOR_ID_TAKEN"],
    ["a fee over the cap", new FeeCapError(300_000_000n, 200_000_000n), "FEE_TOO_HIGH"],
    ["an RPC outage", new ContractCallError("get_company", undefined), "NETWORK"],
    ["a missing invite", new ContractCallError("accept_invite", 7), "NOT_INVITED"],
    ["an unknown company", new ContractCallError("get_company", 1), "COMPANY_NOT_FOUND"],
    ["a refused proof", new ContractCallError("register", 3506), "PROOF_REFUSED"],
    ["an RPC timeout", new RpcTimeoutError("simulateTransaction"), "NETWORK"],
    ["a refused submit", new SubmitRejectedError("ERROR"), "TX_FAILED"],
    ["a malformed chain value", new DecodeError("x"), "CHAIN_DISAGREES"],
    ["a closed passkey prompt", new DOMException("The operation either timed out or was not allowed.", "NotAllowedError"), "PASSKEY_CANCELLED"],
  ];
  it.each(cases)("maps %s", (_label, err, code) => {
    const mapped = toWorkerError(err);
    expect(mapped).toBeInstanceOf(WorkerError);
    expect((mapped as WorkerError).code).toBe(code);
  });

  it("keeps the contract's own number on an unmapped refusal", () => {
    const mapped = toWorkerError(new ContractCallError("accept_invite", 19)) as WorkerError;
    expect(mapped.code).toBe("SIMULATION_FAILED");
    expect(mapped.contractCode).toBe(19);
  });

  it("passes a sponsor refusal through with its outcome", () => {
    const refusal = new SponsorError("relay_timeout", 504);
    expect(toWorkerError(refusal)).toBe(refusal);
    expect(refusal.outcome).toBe("unknown");
  });

  it("never lets an unknown error's own text reach the screen", () => {
    const mapped = toWorkerError(new Error("seed SCZ... and 1234.5 USDC leaked here"));
    expect((mapped as WorkerError).code).toBe("UNEXPECTED");
    expect(mapped.message).not.toMatch(/seed|1234|USDC/);
  });

  it("reads a simulation's contract refusal from the RPC's text, ignoring the diagnostic log after it", () => {
    const text = "HostError: Error(Contract, #7)\n\nEvent log (newest first):\n   0: [Diagnostic Event] ... Error(Contract, #2)";
    expect(simulationRefusal(text)).toMatchObject({ code: "NOT_INVITED", contractCode: 7 });
    expect(simulationRefusal("HostError: Error(Budget, ExceededLimit)")).toMatchObject({ code: "SIMULATION_FAILED", contractCode: undefined });
  });
});

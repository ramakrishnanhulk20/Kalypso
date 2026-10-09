export type SandboxErrorCode =
  | "INVALID_AMOUNTS"
  | "NOT_ENOUGH_XLM"
  | "BUSY"
  | "NO_SANDBOX"
  | "SIMULATION_FAILED"
  | "FEE_TOO_HIGH"
  | "SUBMIT_REFUSED"
  | "TRANSACTION_FAILED"
  | "TRANSACTION_EXPIRED"
  | "PENDING"
  | "NOT_ON_CHAIN"
  | "CHAIN_DISAGREES"
  | "PAY_FAILED";

/**
 * A sandbox step refused or failed. The message is plain English for the screen and never carries
 * an amount, a balance or a key (threat model C12). Running the sandbox again resumes from the
 * chain, so every code except INVALID_AMOUNTS, NOT_ENOUGH_XLM and CHAIN_DISAGREES clears on a retry
 * once its cause has passed.
 */
export class SandboxError extends Error {
  readonly code: SandboxErrorCode;
  /** The contract's own error number when the network named one. */
  readonly contractCode: number | undefined;

  constructor(code: SandboxErrorCode, message: string, contractCode?: number) {
    super(message);
    this.name = "SandboxError";
    this.code = code;
    this.contractCode = contractCode;
  }
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new DOMException("The sandbox run was stopped.", "AbortError");
}

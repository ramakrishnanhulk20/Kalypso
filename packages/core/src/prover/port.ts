import type {
  KeyPair,
  ProofEnvelope,
  TransferParams,
  TransferWitness,
  WithdrawParams,
  WithdrawWitness,
} from 'stellar-confidential-token-sdk';

export type { ProofEnvelope } from 'stellar-confidential-token-sdk';

/** What proveTransfer returns: the SDK's TransferEnvelope from its Node entry, declared here so "." never imports that entry. */
export type TransferEnvelope = ProofEnvelope & {
  recipientView: TransferWitness['recipientView'];
  next: TransferWitness['next'];
  rEScalar: TransferWitness['rEScalar'];
};

/**
 * The SDK's withdraw ProofEnvelope plus the spendable opening the withdrawal leaves behind,
 * which the SDK's own proveWithdraw computes but does not return.
 */
export type WithdrawEnvelope = ProofEnvelope & { next: WithdrawWitness['next'] };

/**
 * Builds the zero-knowledge proofs the token checks. The payroll engine and the worker's
 * withdraw take one of these instead of importing a prover, so the same code runs in a browser
 * (createCircuitProver with circuits the page supplies) and in Node (createNodeProver from
 * "@kalypso/core/node", circuits read from disk).
 *
 * Implementations must draw every salt and ephemeral scalar from the platform's secure random
 * generator, so they refuse params that carry their own sigma or rE (threat model C11).
 */
export interface ProverPort {
  proveRegister(keys: KeyPair, acctF?: bigint): Promise<ProofEnvelope>;
  proveTransfer(params: TransferParams): Promise<TransferEnvelope>;
  proveWithdraw(params: WithdrawParams): Promise<WithdrawEnvelope>;
}

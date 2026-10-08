import { loadCircuit } from 'stellar-confidential-token-sdk/node';
import { createCircuitProver, type CircuitProverPort } from './browser.js';

/**
 * The default ProverPort for Node: the register, transfer and withdraw circuits the SDK ships,
 * read from disk by its Node entry, behind the same proving path the browser uses. This module
 * is "@kalypso/core/node" and is never imported from ".", so browser bundles stay free of fs.
 */
export function createNodeProver(): CircuitProverPort {
  return createCircuitProver({
    register: loadCircuit('register'),
    transfer: loadCircuit('transfer'),
    withdraw: loadCircuit('withdraw'),
  });
}

export type { CircuitProverPort } from './browser.js';
export type { ProverPort, ProofEnvelope, TransferEnvelope, WithdrawEnvelope } from './port.js';

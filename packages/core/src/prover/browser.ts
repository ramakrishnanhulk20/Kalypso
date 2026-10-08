import {
  CircuitProver,
  buildRegisterWitness,
  buildTransferWitness,
  buildWithdrawWitness,
  encodeRegisterData,
  encodeTransferData,
  encodeWithdrawData,
  type KeyPair,
  type TransferParams,
  type WithdrawParams,
} from 'stellar-confidential-token-sdk';
import type { ProverPort } from './port.js';

/** A compiled Noir circuit, as the SDK's CircuitProver takes it (the circuit's JSON artifact). */
export type CompiledCircuit = ConstructorParameters<typeof CircuitProver>[0];

/** The three circuits the token verifies, as shipped in stellar-confidential-token-sdk/circuits. */
export interface CircuitSet {
  register: CompiledCircuit;
  transfer: CompiledCircuit;
  withdraw: CompiledCircuit;
}

type CircuitName = keyof CircuitSet;
const CIRCUIT_NAMES: readonly CircuitName[] = ['register', 'transfer', 'withdraw'];

/** A ProverPort that also releases the bb.js backends it holds. */
export interface CircuitProverPort extends ProverPort {
  destroy(): Promise<void>;
}

function requireFreshSalt(params: { sigma?: bigint; rE?: bigint }): void {
  // A fixed salt reused across two proofs lets an amount known from one decrypt the other.
  if (params.sigma !== undefined || params.rE !== undefined) {
    throw new TypeError('Proof params must not carry sigma or rE. The prover draws fresh ones for every proof.');
  }
}

/**
 * A ProverPort over the SDK's browser-safe pieces: its witness builders, CircuitProver (bb.js
 * UltraHonk with the keccak transcript) and its data encoders. This is the path the privacy
 * wallet uses in the browser; "@kalypso/core/node" feeds it circuits read from disk.
 *
 * One CircuitProver per circuit is created on first use and kept, because starting bb.js is the
 * slow part. Proofs on the same circuit run one at a time. In a browser the page must be served
 * with Cross-Origin-Opener-Policy same-origin and Cross-Origin-Embedder-Policy credentialless.
 *
 * @param circuits the register, transfer and withdraw circuit JSON. Pin them to the SDK version
 *   the token's verification keys were made from.
 * @throws TypeError when a circuit is missing or has no bytecode. Each prove call throws
 *   TypeError when params carry sigma or rE (threat model C11).
 */
export function createCircuitProver(circuits: CircuitSet): CircuitProverPort {
  for (const name of CIRCUIT_NAMES) {
    const circuit = (circuits as Partial<CircuitSet> | undefined)?.[name];
    if (typeof circuit !== 'object' || circuit === null || typeof circuit.bytecode !== 'string' || circuit.bytecode === '') {
      throw new TypeError(`The ${name} circuit is missing or has no bytecode.`);
    }
  }
  const provers = new Map<CircuitName, CircuitProver>();
  const queues = new Map<CircuitName, Promise<unknown>>();

  function prove(name: CircuitName, inputs: Parameters<CircuitProver['prove']>[0]): Promise<Uint8Array> {
    const run = async () => {
      let prover = provers.get(name);
      if (prover === undefined) {
        prover = new CircuitProver(circuits[name]);
        provers.set(name, prover);
      }
      return (await prover.prove(inputs)).proof;
    };
    const result = (queues.get(name) ?? Promise.resolve()).then(run, run);
    queues.set(name, result.catch(() => undefined));
    return result;
  }

  return {
    async proveRegister(keys: KeyPair, acctF?: bigint) {
      const witness = buildRegisterWitness(keys, acctF);
      const proof = await prove('register', witness.inputs);
      return { payload: new Uint8Array(encodeRegisterData(witness, proof).bytes()), proof };
    },
    async proveTransfer(params: TransferParams) {
      requireFreshSalt(params);
      const witness = buildTransferWitness(params);
      const proof = await prove('transfer', witness.inputs);
      return {
        payload: new Uint8Array(encodeTransferData(witness, proof).bytes()),
        proof,
        recipientView: witness.recipientView,
        next: witness.next,
        rEScalar: witness.rEScalar,
      };
    },
    async proveWithdraw(params: WithdrawParams) {
      requireFreshSalt(params);
      const witness = buildWithdrawWitness(params);
      const proof = await prove('withdraw', witness.inputs);
      return { payload: new Uint8Array(encodeWithdrawData(witness, proof).bytes()), proof, next: witness.next };
    },
    async destroy() {
      const held = [...provers.values()];
      provers.clear();
      await Promise.all(held.map((prover) => prover.destroy()));
    },
  };
}

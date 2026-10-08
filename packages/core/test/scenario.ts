// One company on the fake ledger, shaped like the testnet e2e: the treasury is registered under
// the company's auditor id, each worker under their own, and a pay transaction carries a
// transfer then a payslip per worker. Secrets are deterministic test values, never real keys.
import { createHash } from 'node:crypto';
import { addressToField, deriveKeys, FR_MODULUS } from 'stellar-confidential-token-sdk';
import type { KalypsoKeys } from '../src/keys.js';
import { FakeLedger, type EventFields } from './fake-ledger.js';
import { testAccount, testContract } from './independent-xdr.js';

export const CONTRACTS = { payroll: testContract(41), token: testContract(42), auditor: testContract(43) };
export const COMPANY = 7n;
export const RUN = 202610n;
export const COMPANY_AUDITOR_ID = 4;
export const COMPANY_AUDITOR_SECRET = 0x5a1a_47e5_0001n;
// Distinctive amounts with digits 0, 1, 8 and 9, which never appear in a Stellar address.
export const PAY = [1_908_190_1n, 8_801_919_09n];
export const FUNDING = 100_000_0000000n;

export function keysFor(account: string): KalypsoKeys {
  const sk = BigInt(`0x${createHash('sha256').update(`keys for ${account}`).digest('hex')}`) % FR_MODULUS;
  const addrF = addressToField(CONTRACTS.token);
  const acctF = addressToField(account);
  return { ...deriveKeys(sk, addrF, acctF), addrF, acctF };
}

/** `tamper` edits a worker's transfer fields in the first pay transaction, as a dishonest history source would. */
export function scenario(opts: { tamper?: ((fields: EventFields) => void)[] } = {}) {
  const ledger = new FakeLedger(CONTRACTS);
  const treasury = testAccount('scenario treasury').publicKey();
  const workers = [testAccount('scenario worker 1').publicKey(), testAccount('scenario worker 2').publicKey()];
  const outsider = testAccount('scenario outsider').publicKey();
  ledger.setAuditorKey(COMPANY_AUDITOR_ID, COMPANY_AUDITOR_SECRET);
  ledger.setAuditorKey(11, 0x11_11n);
  ledger.setAuditorKey(12, 0x12_12n);
  ledger.setAuditorKey(13, 0x13_13n);
  const fromLedger = ledger.ledger + 1;

  ledger.register(treasury, keysFor(treasury), COMPANY_AUDITOR_ID);
  workers.forEach((worker, i) => ledger.register(worker, keysFor(worker), 11 + i));
  ledger.register(outsider, keysFor(outsider), 13);
  ledger.deposit(treasury, treasury, FUNDING);
  ledger.merge(treasury);
  ledger.createCompany(COMPANY, treasury, COMPANY_AUDITOR_ID, 'Fake Co');
  for (const worker of workers) ledger.join(COMPANY, worker);
  ledger.openRun(COMPANY, RUN, 'October 2026', 2);
  const payTx = ledger.pay(
    COMPANY,
    RUN,
    workers.map((worker, i) => {
      const tamper = opts.tamper?.[i];
      return tamper === undefined ? { worker, amount: PAY[i] as bigint } : { worker, amount: PAY[i] as bigint, tamper };
    }),
  );
  return { ledger, treasury, workers, outsider, fromLedger, payTx };
}

export type Scenario = ReturnType<typeof scenario>;

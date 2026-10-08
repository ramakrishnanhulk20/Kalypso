# Attack run: the prove-it command on testnet

Kalypso's prove-it command attacks the product's own promises against the live showcase company on Stellar testnet, then prints what each attack tried and what stopped it. It signs nothing and sends nothing. Every attack is a read or a simulation of current testnet state, so anyone can run it without keys.

- Date: 2026-10-08T07:49:02Z (ledger 5084430)
- Commit: 2c88e5c, with the M6 seed and prove scripts from the working tree on top of it
- Network: Stellar testnet, RPC https://soroban-testnet.stellar.org
- Verifier: `CDPF25R2OEACPIOPWSUMZUQHOPW2OYSRTAOHUU27AGNF5CFLFALWDPYM`
- Auditor registry: `CBG6BCHMPMKQGXAVIU475Q7TGFROD6BGZ5BQFEFBXWTOGSGF542AUZYG`
- Confidential USDC token: `CASNAZGPARZ46BT7IWDDHNZKCHMUWQ35FY4YR4S6YLE45CAJQUPSTTBZ`
- Payroll: `CAC3P6WOEHUH2ZXCJ44TO5Q6RH6ALELP4GWDXUVCFJZ2MTYMZJYNIPWA`
- USDC contract: `CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA`
- Showcase: "Andes Studio (demo)", company 1, seeded by `npm run seed:testnet`; every id, address and transaction is in `packages/contracts/deployments/showcase-testnet.json`

## Run it yourself

```sh
cd packages/core && npm ci && npm run build
cd ../contracts/scripts && npm ci
npm run prove:testnet
```

This run had the seed's private file, so it also checked every decrypted amount against what the seed paid and opened a worker's own payslips. Without that file, the amounts come from the published demo accountant key and the worker half of P10 is skipped, so a stranger's run ends with 9 passed and 1 skipped.

## What this run does not cover

- Only amounts are private. Who pays whom, when, and who is on a roster are public by design (threat model, non-goals).
- RPC keeps about 7 days of history. Until Kalypso's event archive is live, P1, P2, P3 and P10 work only within 7 days of the seed, and P9 within 7 days of the token's deployment. After that they fail and say why; they never pass on missing history.
- P1 looks for each salary in 15 encodings. It does not try to break the encryption itself; P3 shows that a wrong key reads nothing.
- Attacks are simulations of what the network would do with each transaction. No attack transaction was submitted.

## Output

```text
Kalypso prove-it: attacking the showcase's promises on Stellar testnet
  when       ledger 5084430, 2026-10-08T07:49:02Z
  showcase   "Andes Studio (demo)", company 1, treasury GA774NZX5OQGBL222I4QO4IZXGRHGWFTONNH3VYGMYXF5VARMAIYSRZU, 6 workers, runs 202609 "September 2026" and 202610 "October 2026"
  contracts  payroll CAC3P6WOEHUH2ZXCJ44TO5Q6RH6ALELP4GWDXUVCFJZ2MTYMZJYNIPWA, token CASNAZGPARZ46BT7IWDDHNZKCHMUWQ35FY4YR4S6YLE45CAJQUPSTTBZ, auditor registry CBG6BCHMPMKQGXAVIU475Q7TGFROD6BGZ5BQFEFBXWTOGSGF542AUZYG, verifier CDPF25R2OEACPIOPWSUMZUQHOPW2OYSRTAOHUU27AGNF5CFLFALWDPYM
  amounts    checked against the private seed file
  Nothing below signs or sends a transaction. Every attack is a read or a simulation of current testnet state.

PASS  P1   A stranger read all 62 showcase transactions from RPC (envelope, result, meta and events, 3.0 MB) and searched them for the 12 salaries in 15 encodings each, and found none, because a salary only ever travels as an encrypted transfer; the same search does find the treasury's public deposit in its deposit transaction (as decimal stroops, i128 big endian, u64 big endian), so it would have seen a salary in plain form.
            Salaries a stranger can read: 0 of 12
PASS  P2   The published demo accountant key opened Andes Studio's payroll through Kalypso's audit: all 12 payments decrypted, each run total adds up and every amount equals what the seed paid, and nothing is undecryptable, because the treasury's transfers are encrypted to this one accountant key.
            Salaries the accountant can read: 12 of 12
PASS  P3   A random auditor key tried to open the same payroll and read nothing: every amount it decrypts falls outside any possible balance, so Kalypso marks all 12 payments undecryptable and counts none of them.
            Salaries a random key can read: 0 of 12
PASS  P4   Paying worker GAGNT6...HD3U a second time in run 202610 "October 2026", simulated as the treasury itself, was refused by the payroll contract with Error(Contract, #14) AlreadyPaid, because the run's paid flag for that worker is already set (the run is open).
PASS  P5   The admin of "Outsider Co (demo)" (company 2) tried to move Andes Studio's money three ways (paying into run 202610 unsigned, paying with a forged treasury signature, and calling the token's transfer out of the treasury directly), and the network refused all three, because only the treasury's own key can authorise its money.
            pay into run 202610 with no treasury signature: Error(Auth, InvalidAction), no signature for GA774N...SRZU
            pay with a treasury authorisation signed by another key: Error(Auth, InvalidAction), signature rejected for GA774N...SRZU
            the token's confidential_transfer out of the treasury, called directly: Error(Auth, InvalidAction), no signature for GA774N...SRZU
PASS  P6   Paying GDDKZG...BBXQ, an address that holds a token account but is not on Andes Studio's roster, simulated as the treasury itself, was refused by the payroll contract with Error(Contract, #8) NotActive, because pay checks the roster for every worker before any money moves.
PASS  P7   Swapping the proof rules was tried as the account that deployed the verifier (update_verification_key on the transfer circuit) and refused with Error(Contract, #2000) Unauthorized, because the token's verifier has no admin and no manager left and its three keys still hash to the pinned circuits.
PASS  P8   A stranger with a brand-new key tried to rotate the accountant's auditor key (id 5) to one of its own, unsigned and with a forged signature, and the registry refused both, because only the id's owner, the accountant's account, can change the key.
            unsigned: Error(Auth, InvalidAction), no signature for GDDJCJ...QLLE
            forged: Error(Auth, InvalidAction), signature rejected for GDDJCJ...QLLE
PASS  P9   Checked that no USDC can go missing behind the encryption: the token's balance on the USDC contract equals every public deposit minus every public withdrawal since its first ledger 5083382 (7 deposits and 1 withdrawal, read from RPC events), so every confidential balance is backed.
PASS  P10  An outsider sent GAGNT6...HD3U a direct confidential transfer and a public deposit; both reached the worker's verified balance, yet the worker sees only its 2 real payslips and the accountant's totals count neither, because a payslip needs Andes Studio's own payroll event and paid flag in the same transaction.

10 passed, 0 failed of 10 checks. RESULT: PASS
```

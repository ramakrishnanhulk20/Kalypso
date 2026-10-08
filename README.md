# Kalypso

Kalypso (Greek Καλυψώ, "she who conceals") is payroll on Stellar where nobody can read the salaries except the people who should.

A company pays its team in USDC. The public ledger shows that each payment happened, never how much. Each worker reads only their own pay, and the company's accountant holds a key that reads every amount the company paid. It is built on Stellar's Confidential Tokens (OpenZeppelin), which SDF lists for payroll.

Status: work in progress for the Find Your Way hackathon. Testnet only. Not audited.

## What is here so far

| Folder | What it is |
|---|---|
| `packages/contracts/payroll` | Soroban payroll contract: companies, invite and accept, payroll runs, pay at most once per worker per run |
| `packages/contracts/auditor` | Auditor key registry: an accountant registers their own key and only they can rotate it |
| `packages/contracts/fixtures` | The OpenZeppelin confidential token, verifier and example auditor builds our tests run against |
| `packages/core` | Spreadsheet import, USDC amounts, address parsing, and key derivation for wallet and passkey users |
| `packages/server` | Fee sponsor for workers' own transactions, and an archive of public events after RPC's 7-day window |
| `docs/security/threat-model.md` | The threat model; section C is the definition of done for every component |

## Live on Stellar testnet (release v0.1.0)

| Contract | Address |
|---|---|
| Payroll | [`CAC3P6WOEHUH2ZXCJ44TO5Q6RH6ALELP4GWDXUVCFJZ2MTYMZJYNIPWA`](https://stellar.expert/explorer/testnet/contract/CAC3P6WOEHUH2ZXCJ44TO5Q6RH6ALELP4GWDXUVCFJZ2MTYMZJYNIPWA) |
| Auditor registry | [`CBG6BCHMPMKQGXAVIU475Q7TGFROD6BGZ5BQFEFBXWTOGSGF542AUZYG`](https://stellar.expert/explorer/testnet/contract/CBG6BCHMPMKQGXAVIU475Q7TGFROD6BGZ5BQFEFBXWTOGSGF542AUZYG) |
| Confidential USDC (OpenZeppelin) | [`CASNAZGPARZ46BT7IWDDHNZKCHMUWQ35FY4YR4S6YLE45CAJQUPSTTBZ`](https://stellar.expert/explorer/testnet/contract/CASNAZGPARZ46BT7IWDDHNZKCHMUWQ35FY4YR4S6YLE45CAJQUPSTTBZ) |
| Verifier (OpenZeppelin, locked) | [`CDPF25R2OEACPIOPWSUMZUQHOPW2OYSRTAOHUU27AGNF5CFLFALWDPYM`](https://stellar.expert/explorer/testnet/contract/CDPF25R2OEACPIOPWSUMZUQHOPW2OYSRTAOHUU27AGNF5CFLFALWDPYM) |

The payroll and auditor contracts were built by GitHub Actions from tag `v0.1.0` and each wasm carries a build attestation. Check that a live contract came from this repo:

```bash
stellar contract info build --id CAC3P6WOEHUH2ZXCJ44TO5Q6RH6ALELP4GWDXUVCFJZ2MTYMZJYNIPWA --network testnet
```

Check that nobody, including us, can change which proofs the verifier accepts, and that neither of our contracts has an admin or an upgrade path (15 checks read from chain state):

```bash
cd packages/contracts/scripts && npm ci && npm run check:testnet -- --wasm-dir <folder with the v0.1.0 release wasm files>
```

## Run the tests

```bash
cd packages/contracts && cargo test
```

```bash
cd packages/core && npm install && npm test
```

```bash
cd packages/server && npm install && npm test
```

## License

MIT. The files in `packages/contracts/fixtures` are OpenZeppelin builds under Apache-2.0.

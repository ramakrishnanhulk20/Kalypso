# Kalypso

Kalypso (Greek Καλυψώ, "she who conceals") is payroll on Stellar where nobody can read the salaries except the people who should.

A company pays its team in USDC. The public ledger shows that each payment happened, never how much. Each worker reads only their own pay, and the company's accountant holds a key that reads every amount the company paid. It is built on Stellar's Confidential Tokens (OpenZeppelin), which SDF lists for payroll.

Status: work in progress for the Find Your Way hackathon. Testnet only. Not audited by a security firm. It is self-audited: a written threat model, an attack test for every claim, and a three-pass review whose 20 findings are all fixed or named as limits (`docs/security/`).

## What is here so far

| Folder | What it is |
|---|---|
| `packages/contracts/payroll` | Soroban payroll contract: companies, invite and accept, payroll runs, pay at most once per worker per run |
| `packages/contracts/auditor` | Auditor key registry: an accountant registers their own key and only they can rotate it |
| `packages/contracts/fixtures` | The OpenZeppelin confidential token, verifier and example auditor builds our tests run against |
| `packages/core` | Spreadsheet import, USDC amounts, address parsing, and key derivation for wallet and passkey users |
| `packages/server` | Fee sponsor for workers' own transactions, and an archive of public events after RPC's 7-day window |
| `docs/security/threat-model.md` | The threat model; section C is the definition of done for every component |

## Live on Stellar testnet (release v0.1.1)

| Contract | Address |
|---|---|
| Payroll (v0.1.1) | [`CBUIUWF6PLCQHTLYUCYIKB34DCFXJG722N2JWE44LVICRCEY34KK7XVZ`](https://stellar.expert/explorer/testnet/contract/CBUIUWF6PLCQHTLYUCYIKB34DCFXJG722N2JWE44LVICRCEY34KK7XVZ) |
| Auditor registry (v0.1.0) | [`CBG6BCHMPMKQGXAVIU475Q7TGFROD6BGZ5BQFEFBXWTOGSGF542AUZYG`](https://stellar.expert/explorer/testnet/contract/CBG6BCHMPMKQGXAVIU475Q7TGFROD6BGZ5BQFEFBXWTOGSGF542AUZYG) |
| Confidential USDC (OpenZeppelin) | [`CASNAZGPARZ46BT7IWDDHNZKCHMUWQ35FY4YR4S6YLE45CAJQUPSTTBZ`](https://stellar.expert/explorer/testnet/contract/CASNAZGPARZ46BT7IWDDHNZKCHMUWQ35FY4YR4S6YLE45CAJQUPSTTBZ) |
| Verifier (OpenZeppelin, locked) | [`CDPF25R2OEACPIOPWSUMZUQHOPW2OYSRTAOHUU27AGNF5CFLFALWDPYM`](https://stellar.expert/explorer/testnet/contract/CDPF25R2OEACPIOPWSUMZUQHOPW2OYSRTAOHUU27AGNF5CFLFALWDPYM) |

The earlier v0.1.0 payroll, [`CAC3P6WOEHUH2ZXCJ44TO5Q6RH6ALELP4GWDXUVCFJZ2MTYMZJYNIPWA`](https://stellar.expert/explorer/testnet/contract/CAC3P6WOEHUH2ZXCJ44TO5Q6RH6ALELP4GWDXUVCFJZ2MTYMZJYNIPWA), is kept on chain and no longer used by the showcase.

Both contracts were built by GitHub Actions from a release tag and each wasm carries a build attestation. The payroll comes from tag `v0.1.1`. The auditor registry was deployed from `v0.1.0` and kept, because its wasm (`90127a7d...`) is byte-identical in both releases. Check that the live payroll came from this repo:

```bash
stellar contract info build --id CBUIUWF6PLCQHTLYUCYIKB34DCFXJG722N2JWE44LVICRCEY34KK7XVZ --network testnet
```

It answers with `.github/workflows/release.yml` at tag `v0.1.1`, commit `03dea9094ce7225fbe15845d2e265561c67b562c`, built on a GitHub-hosted runner.

Check that nobody, including us, can change which proofs the verifier accepts, that neither of our contracts has an admin or an upgrade path, and that every contract has at least 14 days before it archives (18 checks read from chain state). First download `kalypso_payroll.wasm` from release v0.1.1 and `kalypso_auditor.wasm` from release v0.1.0 on this repo's [Releases page](https://github.com/ramakrishnanhulk20/Kalypso/releases), each into its own folder:

```bash
cd packages/contracts/scripts && npm ci && npm run check:testnet -- --wasm-dir <v0.1.1 release folder> --auditor-wasm-dir <v0.1.0 release folder>
```

Attack the showcase company's promises on testnet and print what stopped each attack (13 checks, no keys needed; the last run is in `docs/security/attack-run.md`):

```bash
cd packages/core && npm ci && npm run build
cd ../contracts/scripts && npm ci && npm run prove:testnet
```

The history checks read RPC, which keeps about the last 7 days. Add `-- --archive <url>` to read older ledgers from Kalypso's event archive; its URL goes here after the archive is deployed.

`npm run keepalive:testnet`, from the same folder, extends the storage life of all four contracts and their code (60 days by default) so none archives while it is being judged. Anyone may pay for an extension and it changes nothing else; it pays from the stellar CLI identity the deploy uses.

## Run the tests

On 8 October: 115 payroll and 43 auditor tests (`cargo test`), 539 core tests at 98.56% line coverage, 243 server tests at 98.15%, and 11 for the testnet scripts (`npm test` in `packages/contracts/scripts`).

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

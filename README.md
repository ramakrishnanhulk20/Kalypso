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

# Fixtures

Compiled OpenZeppelin confidential token contracts (Apache-2.0), fetched from Stellar testnet with `stellar contract fetch --wasm-hash <hash> --network testnet`. They are the 31 Jul 2026 revision (OpenZeppelin/stellar-contracts commit 98090b3) built with soroban-sdk 27.0.5. Tests load them so our contracts are checked against the exact code that runs on chain.

| File | sha256 (equals the on-chain wasm hash) | What it is |
|---|---|---|
| confidential_token.wasm | c77ac818ab3af1a2b9cdbc54964d68070f106fb72c9172ba4fff186995704cfd | Confidential token wrapper, `NoHooks` |
| confidential_verifier.wasm | 93db2afdcfa45ad0ced0dcd90dd2fc2743227b786e89b2dd4c74fe6cf184957f | UltraHonk proof verifier |
| stock_auditor.wasm | 7bde3d9780976ace1b41dd3926cdff3ebd0c91c2685175e563b1bb43de4a64b6 | OpenZeppelin's example auditor registry (manager-controlled). Used only in tests; Kalypso deploys its own registry. |

Check a file: `sha256sum confidential_token.wasm`.

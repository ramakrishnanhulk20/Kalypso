# Architecture

Kalypso pays a team in confidential USDC on Stellar. Amounts are hidden on the public ledger; each worker reads their own pay; the company's accountant reads everything the company paid. This page shows how the pieces fit, one payroll run end to end, and what depends on what.

Testnet stack (from `packages/contracts/deployments/testnet.json`; the final stack is redeployed from an attested GitHub release and this table is updated then):

| Contract | Code | Role |
|---|---|---|
| Payroll | `kalypso-payroll` (this repo) | Companies, invites, runs, pay at most once per worker per run |
| Auditor registry | `kalypso-auditor` (this repo) | Each accountant registers and controls their own auditor key |
| Confidential USDC | OpenZeppelin confidential token, wasm `c77ac818...` | Encrypted balances and transfers over testnet USDC |
| Verifier | OpenZeppelin UltraHonk verifier, wasm `93db2afd...` | Checks every proof; admin and manager renounced, keys can never change |
| USDC | Circle's testnet USDC token contract `CBIELTK6...DAMA` | The money underneath |

## 1. System overview

```mermaid
flowchart LR
  subgraph Browser["Browser (the app)"]
    EC[Employer console]
    WP[Worker portal]
    AV[Accountant view]
    PP[Public proof page]
    CORE["@kalypso/core<br/>CSV parser, keys, run engine,<br/>payslips, audit, proofs"]
  end
  subgraph Wallets
    FR[Freighter]
    PK[Passkey smart wallet]
  end
  subgraph Server["Kalypso server"]
    SP[Fee sponsor]
    AR[(Event archive)]
  end
  subgraph Stellar["Stellar testnet"]
    PAY[Payroll contract]
    TOK[Confidential USDC]
    VER[Verifier, locked]
    AUD[Auditor registry]
    USDC[USDC token]
  end
  CH[OpenZeppelin Channels]
  ANC[SDF test anchor<br/>SEP-10 and SEP-24]

  EC --> CORE
  WP --> CORE
  AV --> CORE
  PP --> CORE
  CORE -- sign --> FR
  CORE -- sign --> PK
  CORE -- read and submit --> Stellar
  WP -- worker transactions --> SP
  SP --> CH --> Stellar
  AR -- copies public events --> Stellar
  CORE -- history after 7 days --> AR
  PAY --> TOK
  TOK --> VER
  TOK --> AUD
  TOK --> USDC
  WP -- cash out --> ANC
```

Amounts exist in plain form only in the employer's browser (the CSV they upload), the worker's browser (their own payslips) and the accountant's browser (with their key). The server sees transaction bytes, where amounts are ciphertexts, and public events.

## 2. One payroll run, end to end

```mermaid
sequenceDiagram
  autonumber
  actor E as Employer (browser)
  participant C as @kalypso/core
  participant W as Freighter
  participant P as Payroll contract
  participant T as Confidential USDC
  participant V as Verifier
  participant A as Auditor registry

  E->>C: upload CSV (addresses, amounts)
  C->>C: parse once into integer stroops
  C->>P: read company, run, roster, paid flags
  C->>T: read treasury and worker accounts
  C->>A: read auditor keys
  loop each batch of at most 2 workers, one at a time
    C->>C: build proofs in order, save the new balance opening
    C->>W: sign pay(company, run, items)
    W-->>C: signed transaction
    C->>P: submit
    P->>P: check admin, run open, worker active, not yet paid
    P->>T: confidential_transfer(admin, worker, proof)
    T->>A: get_key(auditor ids)
    T->>V: verify_proof
    T-->>P: ok
    P-->>C: PayslipIssued (no amount)
    C->>T: read treasury commitment
    C->>C: confirm it equals the saved opening, so exactly the CSV amounts left
  end
  C-->>E: every row paid, from on-chain paid flags
```

A run that crashes halfway resumes from the on-chain paid flags; nobody is paid twice, and a worker paid in one run cannot be paid again in it.

## 3. What depends on what

```mermaid
flowchart TB
  subgraph Ours["This repo"]
    PAYC["kalypso-payroll<br/>soroban-sdk 27.0.5"]
    AUDC["kalypso-auditor<br/>soroban-sdk 27.0.5<br/>uses OpenZeppelin key validation"]
    CORE["@kalypso/core"]
    SRV["@kalypso/server"]
    SCR["deploy and check scripts"]
  end
  subgraph OZ["OpenZeppelin stellar-contracts, commit 98090b3"]
    TOKC["confidential token wasm c77ac818"]
    VERC["UltraHonk verifier wasm 93db2afd"]
  end
  SDK["stellar-confidential-token-sdk 0.1.9<br/>proofs and decryption"]
  STL["@stellar/stellar-sdk 16.3.1"]
  PKK["passkey-kit 0.19.1"]

  PAYC -- calls --> TOKC
  TOKC -- reads keys from --> AUDC
  TOKC -- verifies with --> VERC
  CORE --> SDK
  CORE --> STL
  CORE -- builds calls for --> PAYC
  CORE -- builds calls for --> TOKC
  CORE -- passkey workers --> PKK
  SRV --> STL
  SCR -- deploys and locks --> VERC
  SCR -- deploys --> TOKC
  SCR -- deploys --> PAYC
  SCR -- deploys --> AUDC
```

## Interface the app uses

Payroll contract (`packages/contracts/payroll/src/contract.rs` holds the exact signatures, errors and doc comments):

| Call | Who signs | What it does |
|---|---|---|
| `create_company(admin, auditor_id, label)` | admin | New company; admin must already be registered with the token under `auditor_id` |
| `propose_admin` / `cancel_admin_proposal` / `accept_admin` | current admin, then the incoming admin | Two-step handover; the incoming admin must be registered under the company's auditor id |
| `invite_worker(company_id, worker)` / `revoke_invite` | admin | Invite, or withdraw an unaccepted invite |
| `accept_invite(company_id, worker)` | worker | Joins the roster; the worker must already be registered with the token |
| `remove_worker(company_id, worker)` | admin | Leaves pay history in place |
| `open_run(company_id, run_id, period_label, expected_count)` | admin | A run id opens once per company, ever |
| `pay(company_id, run_id, items)` | admin | 1 or 2 `(worker, proof data)` items; each worker at most once per run |
| `close_run(company_id, run_id)` | admin | No more pay in this run |
| `get_company`, `get_run`, `is_paid`, `worker_status`, `get_roster`, `pending_admin`, `token`, `company_count` | none | Reads |

Events carry no amounts: `CompanyCreated`, `AdminProposed`, `AdminProposalCancelled`, `AdminChanged`, `WorkerInvited`, `InviteRevoked`, `WorkerJoined`, `WorkerRemoved`, `RunOpened`, `PayslipIssued`, `RunClosed`. The first topic after the name is always `company_id`.

Auditor registry: `register_key(owner, point) -> u32`, `rotate_key(auditor_id, new_point)`, `propose_owner`, `cancel_owner_proposal`, `accept_owner`, `get_key(auditor_id)`, `owner_of`, `pending_owner`, `key_count`. No admin.

Confidential USDC (OpenZeppelin): `register(account, auditor_id, data)`, `deposit(from, to, amount)`, `merge(account)`, `confidential_transfer(from, to, data)`, `withdraw(from, to, amount, data)`, `confidential_balance(account)`. Deposit and withdraw amounts are public; transfer amounts and balances are not.

Server: `POST /api/sponsor` and `GET /api/sponsor/status` (fees for workers' own transactions, never an open relay), and the archive's `/v1/...` endpoints, compatible with the confidential SDK's indexer clients.

Costs on testnet, measured: pay 2 workers 0.49 XLM, pay 1 worker 0.24 XLM, create company 0.56 XLM, invite 0.28 XLM, accept 0.30 XLM, open run 0.38 XLM, token register 0.051 XLM. Most of the one-off figures are storage rent prepaid for about 180 days.

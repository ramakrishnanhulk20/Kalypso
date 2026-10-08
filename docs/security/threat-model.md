# Threat model

Status: written at the architecture gate on 7 Oct 2026, before any contract code, and kept current as the code lands. Section C is the definition of done: a piece of the system is finished only when every invariant in C that applies to it is upheld and a test shows it.

What the system is: an employer pays a team in confidential USDC on Stellar. The public ledger shows that payments happened, not how much. Each worker reads only their own pay. The company's accountant holds an auditor key that reads every amount the company paid. Workers can withdraw to plain USDC and cash out at an anchor. It is built on OpenZeppelin's confidential token for Stellar (the 31 Jul 2026 revision, commit 98090b3 of OpenZeppelin/stellar-contracts), plus a payroll contract of our own, a web app, a fee sponsor and an event archive. Testnet only.

Upstream references below point at OpenZeppelin/stellar-contracts at commit 98090b3 unless they say otherwise.

---

## A) App-class risk profile

This is a multi-tenant payments system that combines four security classes:
1. A delegated money mover: a shared contract moves one party's funds to others under that party's signature, with each company's state in one contract.
2. A confidentiality system: secrecy rests on keys derived in the browser and on random salts, and the hidden data (salaries) is easy to guess, because anyone can encrypt a candidate amount and compare.
3. A service that pays for and relays user-supplied transactions, and in demo mode may act for anonymous visitors.
4. A service that copies upstream data (RPC events) into its own store and serves it back as the history wallets rebuild balances from.

It also renders and exports strings that other tenants wrote on chain, and talks to a third-party anchor through a sign-a-challenge login and a popup.

| # | Category | Applies? | The data flow it rides on |
|---|---|---|---|
| A1 | Broken authorization on contract writes | Yes | Adding and removing workers, opening, paying and closing runs all change company state. Pay moves treasury funds, and the token requires the treasury's own signature (`packages/tokens/src/confidential/mod.rs`, transfer). |
| A2 | Cross-tenant collision | Yes | One payroll contract, one token and one auditor registry serve every company. A caller-chosen run id that is not scoped to the company lets one company open, close or mark paid another company's run. Auditor ids are the only thing that separates companies inside the token. |
| A3 | Replay and double processing | Yes | Pay marks (run, worker) as paid, the console retries failed batches, and signed auth entries can sit with a relayer until they expire. A double pay is real money. |
| A4 | Ordering and races | Yes | Transfer proofs chain on the treasury's running balance, a relayer may submit in parallel, and demo users may share accounts. Outsiders cannot invalidate a spend proof, because incoming funds land in a separate receiving balance (`docs/DESIGN.md`). The treasury's own overlapping actions can. |
| A5 | Privileged key abuse | Yes | Verifier keys and auditor keys are set by a manager role (`examples/confidential/verifier/src/contract.rs`, `examples/confidential/auditor/src/contract.rs`). A swapped verification key lets forged withdraws drain every company's pooled USDC. |
| A6 | Cryptographic misuse | Yes, strongly | Proofs are built in the browser and keys are derived from a wallet signature or a passkey PRF. A reused salt lets an amount known from one operation decrypt another (`docs/DESIGN.md`). The host silently reduces non-canonical field values. |
| A7 | Privacy leaks by inference | Yes | Deposit and withdraw amounts are public. Transfer events name the employer and the worker. The roster is on chain. The sender's auditor sees the sender's running balance. The anchor sees cash-out amounts. |
| A8 | Client-side secret exposure | Yes | Derived keys and cached openings live in browser storage, proving libraries hold keys in memory, and any website can ask a wallet to sign our key-derivation message. |
| A9 | Open relay and cost abuse | Yes | The fee sponsor pays for what browsers send, demo actions run on our server, and the archive API is public. |
| A10 | Query injection | Narrowly | The archive API takes contract, account and cursor and reaches the database. |
| A11 | Stored content shown to other users (XSS, spreadsheet formula injection) | Yes | Any admin writes labels and metadata that reach the public page and the accountant's CSV export. Uploaded CSV filenames and cells are displayed. |
| A12 | Trusting upstream replies | Yes | The archive copies RPC, wallets rebuild from the archive, and a console might read statuses from a relayer reply. Balance integrity fails closed against on-chain commitments; which run a payslip belongs to does not, unless we check it. |
| A13 | Misusing a third-party login | Yes | SEP-10 and the SEP-24 popup. Signing an unchecked challenge can mean signing a real transaction. Trusting popup messages lets any window fake a finished withdraw. |
| A14 | Funds locked by lost keys or lost history | Yes | Keys are derived deterministically and the archive can have gaps. After RPC's 7-day window the money stays on chain but cannot be spent without history. |
| A15 | Server-side request forgery | Not as designed | The server only calls fixed hosts. It becomes live if any route takes a URL or domain from a request. C22 keeps it closed. |
| A16 | Reentrancy | Not in the classic form | Soroban blocks a contract from re-entering itself, and payroll only calls our own token. The close cousin does apply: the same worker twice in one batch must not be paid twice (C7). |
| A17 | Upgrade abuse | Depends on the upgrade decision | Soroban signatures bind the nested token call's exact arguments, so even a malicious payroll upgrade cannot move funds the admin did not sign for. It could still forge paid flags and payslip events. |
| A18 | File storage, path traversal, unsafe deserialization | No | The CSV is parsed in the browser and never stored. |

---

## B) Threat model

Attackers considered: an anonymous internet user; a malicious company admin (one tenant); a malicious worker; a compromised or lying upstream (RPC, archive host, anchor, an npm package, a wallet extension); an insider holding our deploy or admin keys.

### Trust boundaries
- TB1 Browser to contracts: every argument to the payroll and token functions. The contracts trust only what Soroban signature checks and proof checks establish.
- TB2 Browser to our server: the sponsor route, the demo routes, the archive API. Callers are anonymous.
- TB3 Our server to the relayer, and its reply back.
- TB4 Stellar RPC and Horizon to the archive job and the browsers: events, ledger entries, simulation, transaction status.
- TB5 Archive database to browsers: our stored copy, read back and used to rebuild balances.
- TB6 Wallet to app: the address and signatures the wallet returns, and the passkey PRF output. A malicious extension can pose as the wallet.
- TB7 Browser storage to app: cached openings and any persisted key material, read back.
- TB8 Anchor to browser: stellar.toml, the SEP-10 challenge, the JWT, the SEP-24 URL, popup messages, the transaction record.
- TB9 File to app: the employer's CSV.
- TB10 One tenant's on-chain data read by another tenant or the public: labels, metadata, rosters, auditor ids, events.
- TB11 Contract to contract: payroll to token, token to verifier, token to auditor, token to the USDC contract. A verifier's yes is only as trustworthy as whoever can change its keys.

### Attacker-controlled inputs
- On chain: company id, run id, period label, expected count, metadata hash, auditor id (at company creation and at token registration), worker addresses, the pay items list (length, order, duplicates, ciphertext and proof bytes, non-canonical encodings), deposit's recipient and amount, withdraw's destination and amount.
- To our server: the whole transaction envelope (operation types and count, contract ids, functions, arguments, resource fee, fee, time bounds, network passphrase), auth entries (root call, nested calls, expiry), demo action names and parameters, archive query parameters and page size, headers, body size, request rate.
- In the browser: CSV bytes and filename (BOM, encodings, formulas, duplicates, muxed addresses, exponents, thousands separators), URL parameters and invite links, postMessage from any window.
- Indirect: RPC, Horizon, relayer and friendbot replies; archive rows; the anchor's toml, challenge, JWT, interactive URL and transaction record; wallet replies; PRF output; cached openings; events from other tenants and from any contract that copies our event shapes; dust deposits and transfers anyone can send to a treasury or worker (the token's `deposit(from, to, amount)` lets anyone credit any account); the key stored under an auditor id; the verification keys.

### Privileged position and assets
- The wrapper pools every company's deposited USDC. Forged withdraw proofs would drain all of it.
- The verifier's manager key decides which proofs pass.
- The auditor's manager key decides which public key each auditor id encrypts to, for every future transfer of every account bound to that id.
- The payroll contract holds rosters, runs and paid flags, and emits the payslip events workers and accountants read as proof of pay.
- The server environment holds the relayer key and the database URL.
- The sponsor can pay fees for any transaction it accepts.
- Each browser holds the user's encryption secret, cached openings and a live wallet connection. The employer's browser also holds the plaintext salary table. The accountant's holds the auditor secret: one key opens the company's whole history.
- After 7 days the archive is the only source of the events a wallet needs to spend.
- The public page and the demo are what judges see.

### Attacker goals
- G1 Drain the pooled USDC: forged withdraws after a verification-key swap, a bug in the verifier or circuits, a replayed withdraw.
- G2 Read salaries they should not see: phish the derivation signature; XSS that reads keys and openings; a demo auditor id shared with real accounts; a worker bound to the wrong auditor id by default or by invite link; a manager rotating an auditor key to one it holds; a weak or reused salt; inference from public deposits and withdrawals.
- G3 Get paid twice, get paid when not owed, or make a worker believe they were paid: run id collision across companies, duplicates in one pay, a reopened run, a missing roster check, paid flags in expiring storage, a direct transfer or injected archive event shown as a payslip, a stale auth entry submitted later.
- G4 Use or seize our servers: an open fee relay; a signing oracle on demo keys; poisoning the archive; the relayer key leaking through the client bundle or logs; scraping the archive without limits.
- G5 Freeze payroll or lock funds: a run closed by someone else; out-of-order relay submissions; demo races; an auditor key rotated mid-run, which fails proofs already in flight; derived keys drifting; archive gaps after 7 days.

---

## C) Defensive-programming standards (the definition of done)

Each line is an outcome the code must uphold, followed by how a test shows it.

### Keys and admins
- **C1** The token never accepts a proof the published circuits would reject. On-chain verification keys hash to the pinned 31 Jul hashes (register `e01ba872`, transfer `b9c6d437`, withdraw `d800122c`), and no key held on any server can change them. Show: a script hashes the on-chain keys the same way the pins were made, compares them, and lists every admin or manager address. None of those addresses is in the server environment.
- **C2** The key under a company's auditor id changes only by an act of that company's accountant, or never. No server-held key can register or rotate it. Show: a script lists who holds the role, and a rotation attempted with any server key reverts.
- **C3** The wrapper is always solvent: the USDC it holds equals the sum of deposits minus the sum of withdrawals. Show: a script recomputes both sides from events and the USDC balance after the seed run and after every attack test.

### Payroll contract
- **C4** Every change to a company (add worker, remove worker, open run, pay, close run) needs that company's admin signature, and creating a company needs the named admin's signature. Show: one revert test per function, called by a non-admin, with real auth, not mocked auth.
- **C5** Pay moves funds only from the company's stored treasury, only to the item's worker, and only when the treasury signed that exact transfer. Show: tests where an item names a worker not on the roster, and where a caller aims at another company's treasury.
- **C6** Every run and paid record belongs to one company. Nothing company B does can create, read, close or mark paid anything of company A's. Keys are (company id, run id[, worker]), and the paid check takes the company id. Show: B opens A's run id, and A's run and flags are unchanged.
- **C7** A worker is paid at most once per (company, run), across all transactions and retries, including the same worker listed twice in one call. A run id can be opened once per company, ever. Show: a duplicate inside one batch reverts the whole call; a second pay reverts; reopening a closed run reverts.
- **C8** Pay succeeds only if the run exists, belongs to the company and is open, every worker is on the roster at call time, and the batch holds 1 to the measured maximum items. Anything else reverts the whole call with no event and no transfer. The payslip event is emitted only for a transfer that succeeded in the same call. Rosters, runs and paid flags live in persistent storage, never temporary, with their lifetime extended on write. Show: one test per rejection, plus a test that advances past the temporary lifetime and confirms a repeat pay is still blocked.
- **C9** A company's auditor has one source of truth: the auditor id its treasury registered under in the token. The treasury is the company admin. It is checked when the company is created and again at every two-step admin handover: a company, or an incoming admin, whose registered auditor id differs from the company's is rejected. Show: a treasury registered under id 2 with a company naming id 1 reverts; a handover to an account registered under another id reverts.

### Browser keys, crypto and privacy
- **C10** A worker's auditor id never comes from a URL, invite link, archive reply or anything else an attacker can set. It is read from chain or app config, and the worker is shown that id, and who holds it, before signing registration. Show: an invite carrying another id does not change the registration call.
- **C11** Every proof uses a fresh salt from the platform's secure random generator, and a retry after a revert rebuilds the proof with a new salt. Show: two proofs for the same amount and recipient have different salts and ciphertexts; a grep finds no `Math.random` on any path into proving.
- **C12** Plaintext amounts, openings, derived secrets and the signatures they come from never leave the browser: not to our server, not into logs, analytics, error reports or URLs. Show: run the full pay, payslip and accountant flows through a request recorder, then grep the traffic for the amounts in every encoding (decimal, stroops, hex, both byte orders) and for the derivation signature.
- **C13** At most one pay transaction per treasury is in flight. The next batch is proved only against chain state after the previous one is confirmed or has definitely failed. Paid, pending and failed labels come from the on-chain paid check, never from a relayer's reply. Show: close the tab after submitting batch 2 of 3 and reopen; the labels match the chain, nobody is paid twice, and no proof was built on an unconfirmed balance.
- **C14** What the employer approved is what was paid. After each pay lands, the console decrypts the treasury's own balance checkpoints and confirms each transfer equals the confirmed CSV amount in integer stroops. Any mismatch stops the run and is shown. Show: inject a builder bug that pays 1 stroop extra; the console flags it.
- **C15** Derived keys are reproducible and tied to this app. The same wallet always derives the same key here, and no other app or message derives it. The message names our app, our domain, the network and the token contract id, and says to sign it only on our domain. Any change to the message, the key-derivation function or the PRF salt that would change an existing user's key fails CI. If a passkey returns no PRF output, registration is refused, never weakened. Show: pinned test vectors for each path, and a test where a missing PRF refuses.

### History and archive
- **C16** A wallet never shows or spends a balance that does not open the on-chain commitment. Every opening rebuilt from RPC, the archive or the cache is checked against `confidential_balance` before it is displayed or used in a proof. A mismatch shows "history incomplete", never a number. Show: drop one event from the archive reply; the portal shows incomplete and refuses to build a withdraw proof.
- **C17** The archive never claims history it does not have. It stores events verbatim, with id (ledger, tx hash, index) and application order, only from our configured contract ids, deduplicated by id. It tracks which ledger ranges it has ingested without gaps, raises an alarm on a gap well before RPC's 7-day window closes, and every reply carries "complete" and "ingested-through" fields. Show: stop the job for a range and restart it; replies for that range say complete: false until it is backfilled.
- **C18** A payslip is shown only when all of these hold: a payslip event from our payroll contract, a transfer from our token in the same transaction from the company's stored treasury to that worker, the on-chain paid check true, and an in-range decrypted amount. A direct transfer, a deposit, or any event from another contract never becomes a payslip. The accountant's totals count exactly this set. Show: send the worker a direct confidential transfer and a deposit; neither appears as a payslip or in the totals.
- **C19** Decryption is bounded and checked. Any amount outside [0, 2^63), or any sender-auditor balance chain that breaks (previous balance minus amount must equal the new balance), is marked undecryptable and never summed, shown as money or exported. Curve points and field values go through the SDK's canonical, on-curve decoder, and anything else is rejected. Events are deduplicated by event id, never by payload bytes. Show: feed in a ciphertext opened with the wrong key; it is marked and the totals do not change.

### Servers
- **C20** The sponsor pays only for a transaction that, decoded from the exact bytes it will forward, meets all of these: exactly one contract-call operation whose root contract is our payroll or our token; no contract creation or wasm upload anywhere; nested calls only into our contracts or the USDC contract; the testnet passphrase; fees under a fixed cap set from the measured cost of a full pay batch plus margin; and a successful simulation. For the auth-entry path the same rule applies to the host function and every auth entry's call tree. Per-IP limits (using the platform's trusted IP header) and a daily global budget apply. Show: submit a classic payment, a wasm upload, a third-party contract call, an oversized fee and a valid pay; only the last is relayed.
- **C21** Any demo key held by a server signs only transactions the server built itself, from a fixed menu of demo actions, with server-chosen parameters, to the seeded demo addresses. No route accepts XDR, auth entries or destinations for a demo key to sign. Demo accounts hold no contract role, use a demo-only auditor id that no real account is bound to, and their actions run one at a time per account, rate-limited. Show: post a set-options and a payment XDR to every demo route; nothing is signed. Two concurrent demo pays both end in a defined state.
- **C22** The server calls only origins fixed in config (RPC, Horizon, relayer, friendbot, the anchor), never a host or URL taken from a request. Show: grep every server-side fetch for a non-constant URL.
- **C23** No secret (relayer key, any demo key, the database URL) appears in client bundles, responses, logs or error text. Show: build, then grep the static output and a captured log run for each secret value.
- **C24** The archive API treats its parameters as data. Contract must decode to one of our configured ids, account must decode with the Stellar address parser, cursor must match our format, and page size is capped. Queries are parameterized and the API's database role is read-only. Anything else returns 400. Show: SQL metacharacters, an unknown contract, a muxed address, a 10 MB cursor and a page size of 1e9 all return 400.

### Rendering, files and the anchor
- **C25** Strings any company writes on chain (labels, metadata) and CSV cells render as plain text, never as HTML or as a link. Explorer links are built only from a validated transaction hash or address on a fixed origin. Exported CSV cells starting with = + - @, a tab or a carriage return are neutralized, and on-chain strings have a length cap. Show: a company with a label of `=HYPERLINK(...)` and an `<img onerror>` tag; the page shows plain text and the export opens inert.
- **C26** CSV import fails closed. The file has size and row caps. Addresses are decoded with the Stellar address parser, G or C only. Amounts are parsed once, by one decimal parser, into integer stroops, rejecting more than 7 decimals, exponents, separators, negatives and zero. Duplicates are rejected. Every address must be on the on-chain roster (compared after the same decoder) and registered with the token. The confirmation screen, the proof input and the C14 check all use that one parsed value. Show: a fixture with every bad case; each row is rejected with its reason.
- **C27** The anchor flow signs nothing the SDK's SEP-10 challenge checker rejects (sequence 0, the server key from the toml, the home domain, time bounds, the network). Popup messages are accepted only from the anchor's exact origin, compared with `URL().origin` on both sides. The cash-out destination, memo and amount come only from the anchor's authenticated transaction record and are shown to the worker before signing. Show: a challenge with sequence 1 or a payment operation is refused; a message from another origin is ignored.
- **C28** Pages that hold key material load no third-party scripts and run under a Content Security Policy with no inline scripts. Every dependency that touches keys or proving is pinned to an exact version with lockfile integrity, and proving code is served from our own origin. Show: a header check for the policy, and a CI check that fails on any lockfile drift.

### Added at the backend gate review (8 Oct 2026)

The reviewer attacked section C against the code as built and named what it missed. These are part of the definition of done from here on.

- **C29** A balance opening saved for a submitted pay is never overwritten or deleted until that transaction is final, and an in-flight transaction is resolved before any new proof is built. Show: a pay accepted but not yet applied, then a resume, then the pay landing; the run finishes with every row paid once and the treasury still opens.
- **C30** Every amount shown, summed or exported equals the payload of the transaction its event names. The transaction hash is recomputed from the envelope, and every ciphertext field in the event must equal the payload's. Show: an archive that serves a re-encrypted transfer makes that payslip undecryptable, not a different number.
- **C31** The sponsor pays only when every contract the call can execute is ours, USDC's, the verifier, or a wallet whose code is the pinned passkey wallet wasm. Checked on the simulation footprint, not on the authorization tree alone. Show: a self-deployed wallet whose check touches a third-party contract is refused.
- **C32** A run survives a key rotation. Keys are re-read from chain on a failed proof, and a batch that still fails marks only its own rows failed while later batches pay. Show: a worker rotating their auditor key mid-run does not stop the other workers' pay.
- **C33** A worker's auditor id is permanent once registered, so the app defaults to a new id the worker owns and shows who owns any other id before the worker signs. (Strengthens C10.)
- **C34** No real payroll encrypts to the published demo accountant key. Show: the run engine refuses a company or worker bound to the demo auditor id before any transaction.
- **C35** The archive ingests on a schedule that does not depend on visitors, and its alarm reaches a person: health answers 503 on a gap or a stale ingest so an external check fails visibly.
- **C36** No log line joins a client IP with a transaction hash.
- **C37** A workflow that can write build attestations pins every third-party action by commit, not by tag.

### General standards

1. **Primitives over lists.** Each check says what it covers and what it does not.
   - Addresses: the Stellar SDK's address parser, not a regex. Covers the checksum and the address type. Does not cover whether it is the right person; the roster check does that.
   - SEP-10: the SDK's challenge reader and signer verifier, not hand-checked fields. Covers the protocol rules. Does not cover a compromised anchor that is consistent with itself.
   - The sponsor: one structural rule (C20), not a list of function names. The contract-id set is two config values compared by equality, so it covers what we deployed and nothing else. It does not stop valid but spammy calls to our contracts; rate limits do that.
   - Curve points: the SDK's canonical decoder, not a list of known-bad points.
   - Rendering: React's text rendering, not an HTML sanitizer's blocklist.
   - Randomness: `crypto.getRandomValues` only.
2. **Normalize before you compare.** Each pair goes through one parser.
   - CSV address, roster address, event address and the archive's account parameter: the Stellar address decoder.
   - CSV amount, confirmation display, proof input, the C14 check and the export: one decimal-to-stroops parser, BigInt throughout.
   - Popup origin against anchor origin: `URL().origin` on both sides.
   - Event and parameter contract ids against config: decoded ids.
   - Event identity across RPC and the archive: (ledger, tx hash, index), never payload bytes, because the host silently reduces non-canonical values.
   - Company auditor id against the treasury's registered id: both read from chain (C9).
   - Verification-key hashes: the same hash over the same bytes.
   - The sponsor: the exact bytes validated are the bytes forwarded.
   - The client IP for rate limits: the platform's trusted header only.
3. **Validate outputs like inputs.** Each output is treated as input to whoever reads it next.
   - Payslip events and paid flags are read as proof of pay (C8, C18).
   - Labels and metadata reach the page and the export (C25).
   - Archive replies feed proof building (C16, C17).
   - Decrypted amounts feed totals and exports (C19).
   - Proofs built in the browser go to a wallet that cannot show the hidden amount (C14).
   - Relayer replies would otherwise feed the status labels (C13).
   - Logs carry no secrets and no amounts (C12, C23).
   - The public page's privacy claims are outputs a judge acts on, so they must state what stays visible (non-goals below).
4. **Fail closed.**
   - Contract: unknown or closed runs, roster misses, duplicates, oversized batches and unregistered recipients revert the whole call.
   - Wallet: a commitment mismatch, a missing PRF, or a wallet on the wrong network refuses.
   - Server: unparseable XDR, a failed simulation, an unknown action or bad parameters are refused. Every outbound call has a 10 s timeout. Bodies and page sizes are capped, with rate limits and a daily fee budget. The archive job alarms rather than skipping.
   - Decryption: bounded range and bounded iterations.
   - Batch size: taken from measurement, within a hard cap.
   - Defaults: auth entries expire within minutes, demo accounts hold minimal balances, the archive's database role is read-only.
5. **Non-goals.** This system does not defend these, so nobody should assume it does.
   - Only amounts are private. Who pays whom, when, how many workers there are, and who is on a roster are public. Deposit and withdraw amounts are public, so the funding deposit reveals the payroll total, and a worker who withdraws exactly their pay reveals it.
   - The company's accountant sees every amount the company pays and the treasury's balance after each payment, by design.
   - Auditor key rotation protects only future events. A leaked auditor or worker key opens everything encrypted to it, forever.
   - The payroll contract cannot know whether a hidden amount is the right salary. The admin's wallet cannot show it either, so a compromised frontend can misdirect amounts within what the admin signs. C14 detects this after the fact; it does not prevent it.
   - Not defended: a compromised wallet extension or operating system; a user who signs our derivation message on a phishing site; the USDC issuer freezing or clawing back the pool; the anchor's KYC and its view of cash-out amounts; flaws in the unaudited OpenZeppelin circuits, verifier backend or token wasm; the relayer refusing service (a user can still submit and pay their own fee).
   - Testnet only.

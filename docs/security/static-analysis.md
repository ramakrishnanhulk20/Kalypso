# Static analysis

Kalypso's two contracts, payroll and the auditor registry, are immutable once deployed. Every finding the analysers raised was read against the code. Each one is either fixed in code with a test that forces the failure, or kept with a one-line reason that was checked against the code at that line.

## Tools

| Tool | Version | Where it runs | What it checks |
|---|---|---|---|
| Scout | 0.3.17, Docker image `coinfabrik/scout:0.3.17` | CI, job `scout` | Soroban-specific detectors (overflow, unwraps, storage, events, auth, denial of service) |
| cargo audit | 0.22.2 | Locally, against `packages/contracts/Cargo.lock` | Known vulnerabilities and unmaintained crates in the dependency tree |
| clippy | Rust 1.99.0 toolchain, `-D warnings` | CI, job `contracts`, once per crate with `--all-targets` | Every clippy warning fails the build |

The release profile keeps `overflow-checks = true` (`packages/contracts/Cargo.toml`), so any arithmetic outside the fixes below still stops the call instead of wrapping.

## Scout findings

Scout reported 33 findings in CI run 37730333679 on commit `3323445`. Ids are Scout's own numbers from that run. Paths are relative to `packages/contracts`, and line numbers are for that commit; the fixes moved some lines since.

9 are fixed. 24 are justified.

About Storage Change Events (15 rows): every flagged function does emit an event, and a unit test compares that exact event. The detector only counts a call to `env.events()` as an event, and both contracts publish through `#[contractevent]` structs instead, so it misses them. `rotate_key` emits OpenZeppelin's `AuditorRotated`; Scout did not flag it because its storage write happens inside OpenZeppelin's code.

| Id | Severity | Finding | File:line | Status | Reason |
|---|---|---|---|---|---|
| 0 | Medium | Contract Import Dependency | payroll/src/lib.rs:35-38 | Justified | The imported token wasm is pinned by a sha256 in `contractimport!`, so a changed fixture fails the build, and the deploy and check scripts confirm the live token runs that same hash. |
| 1 | Medium | Contract Import Dependency | payroll/src/lib.rs:35-38 | Justified | Same macro call as id 0, reported twice. |
| 2 | Enhancement | Soroban Version | payroll/src/lib.rs:1 | Justified | soroban-sdk is pinned to 27.0.5 to match the deployed OpenZeppelin confidential token (contract meta `rssdkver` 27.0.5). |
| 3 | Critical | Integer Overflow Or Underflow | payroll/src/contract.rs:55 | Fixed | The next company id uses `checked_add` and fails with `CounterOverflow` (21). Test: `create_company_refuses_when_company_ids_run_out`. |
| 4 | Critical | Integer Overflow Or Underflow | payroll/src/contract.rs:260 | Fixed | The roster length uses `checked_add` and fails with `CounterOverflow` (21). Test: `accept_invite_refuses_when_the_roster_length_is_at_its_limit`. |
| 5 | Critical | Integer Overflow Or Underflow | payroll/src/contract.rs:264 | Fixed | The active worker count uses `checked_add` and fails with `CounterOverflow` (21). Test: `accept_invite_refuses_when_the_active_worker_count_is_at_its_limit`. |
| 6 | Critical | Integer Overflow Or Underflow | payroll/src/contract.rs:289 | Fixed | The active worker count uses `checked_sub` and fails with `CounterOverflow` (21). Test: `remove_worker_refuses_when_the_active_worker_count_is_already_zero`. |
| 7 | Critical | Integer Overflow Or Underflow | payroll/src/contract.rs:398 | Fixed | A run's paid count uses `checked_add` and fails with `CounterOverflow` (21). Test: `pay_refuses_when_the_runs_paid_count_is_at_its_limit`. |
| 8 | Medium | Unsafe Unwrap | payroll/src/contract.rs:488 | Fixed | A missing roster entry in `get_roster` fails with `MissingRecord` (22). Test: `get_roster_fails_with_missing_record_when_an_entry_is_gone`. |
| 9 | Medium | Dos Unbounded Operation | payroll/src/contract.rs:485-489 | Justified | `get_roster` is a read-only view whose loop runs at most `limit` times, and `limit` must be 1 to 50. |
| 10 | Medium | Dos Unexpected Revert With Storage | payroll/src/contract.rs:488 | Justified | The flagged `push_back` adds to a local page built for the return value, never to storage, in a read-only view capped at 50 entries. |
| 11 | Medium | Unsafe Unwrap | payroll/src/storage.rs:85 | Fixed | A missing token address fails with `MissingRecord` (22). Test: `a_missing_token_address_fails_with_missing_record`. |
| 12 | Medium | Avoid Vec Map Input | payroll/src/contract.rs:365 | Justified | `pay` rejects more than `MAX_BATCH` = 2 items before its loop, any bad item reverts the whole call, and the network's 132,096 byte transaction cap bounds what the host decodes. |
| 13 | Enhancement | Storage Change Events | payroll/src/contract.rs:49 | Justified | `create_company` emits `CompanyCreated`. |
| 14 | Enhancement | Storage Change Events | payroll/src/contract.rs:216 | Justified | `revoke_invite` emits `InviteRevoked`. |
| 15 | Enhancement | Storage Change Events | payroll/src/contract.rs:365 | Justified | `pay` emits `PayslipIssued` for every item, and a successful call has at least one. |
| 16 | Enhancement | Storage Change Events | payroll/src/contract.rs:242 | Justified | `accept_invite` emits `WorkerJoined`. |
| 17 | Enhancement | Storage Change Events | payroll/src/contract.rs:182 | Justified | `invite_worker` emits `WorkerInvited`. |
| 18 | Enhancement | Storage Change Events | payroll/src/contract.rs:281 | Justified | `remove_worker` emits `WorkerRemoved`. |
| 19 | Enhancement | Storage Change Events | payroll/src/contract.rs:115 | Justified | `cancel_admin_proposal` emits `AdminProposalCancelled`. |
| 20 | Enhancement | Storage Change Events | payroll/src/contract.rs:308-314 | Justified | `open_run` emits `RunOpened`. |
| 21 | Enhancement | Storage Change Events | payroll/src/contract.rs:424 | Justified | `close_run` emits `RunClosed`. |
| 22 | Enhancement | Storage Change Events | payroll/src/contract.rs:87 | Justified | `propose_admin` emits `AdminProposed`. |
| 23 | Enhancement | Storage Change Events | payroll/src/contract.rs:142 | Justified | `accept_admin` emits `AdminChanged`. |
| 24 | Medium | Unnecessary Admin Parameter | payroll/src/contract.rs:49 | Justified | No admin exists in storage before a company is created; the `admin` argument names who is creating it, and that address must authorize. |
| 25 | Enhancement | Soroban Version | auditor/src/lib.rs:1 | Justified | soroban-sdk is pinned to 27.0.5 to match the deployed OpenZeppelin confidential token (contract meta `rssdkver` 27.0.5). |
| 26 | Critical | Integer Overflow Or Underflow | auditor/src/contract.rs:43 | Fixed | The id counter uses `checked_add` and fails with `CounterOverflow` (105). Test: `register_refuses_when_the_id_counter_is_at_its_limit`. |
| 27 | Medium | Ineffective Extend Ttl | auditor/src/storage.rs:114 | Justified | `extend_ttl(key, live_for, live_for)` runs once, when an offer is written, and extends only when the entry would otherwise expire before the offer's deadline; `accept_owner` enforces the deadline itself. |
| 28 | Critical | Integer Overflow Or Underflow | auditor/src/storage.rs:111 | Fixed | The offer's remaining lifetime uses `checked_sub` and fails with `InvalidLiveUntil` (103). Test: `storing_an_offer_with_a_past_deadline_fails_with_invalid_live_until`. |
| 29 | Enhancement | Storage Change Events | auditor/src/contract.rs:91 | Justified | `propose_owner` emits `OwnerProposed`. |
| 30 | Enhancement | Storage Change Events | auditor/src/contract.rs:134 | Justified | `cancel_owner_proposal` emits `OwnerProposalCancelled`. |
| 31 | Enhancement | Storage Change Events | auditor/src/contract.rs:161 | Justified | `accept_owner` emits `OwnerChanged`. |
| 32 | Enhancement | Storage Change Events | auditor/src/contract.rs:36 | Justified | `register_key` emits OpenZeppelin's `AuditorRegistered`, then `OwnerSet`. |

The counter tests write the counter straight into contract storage at its limit, because no test could make billions of real calls. Each one checks that the call fails with the named error and leaves no event and no state change behind.

### Rescan at v0.1.1 (8 Oct 2026)

Scout ran again in CI on commit 03dea90, the code released as v0.1.1. It reports the same 24 findings, every one of a kind justified above, at new line numbers because the payroll gained the accountant check, the handover bound and three counters. No new kind appeared and nothing fixed above came back.

| v0.1.1 location | Same finding as id |
|---|---|
| payroll/src/lib.rs:35-38 (twice) | 0, 1 |
| payroll/src/lib.rs:1, auditor/src/lib.rs:1 | 2, 25 |
| payroll/src/contract.rs:77 (`create_company`'s `admin`) | 24 |
| payroll/src/contract.rs:75-81 `create_company` | 13 |
| payroll/src/contract.rs:129 `propose_admin` | 22 |
| payroll/src/contract.rs:161 `cancel_admin_proposal` | 19 |
| payroll/src/contract.rs:193 `accept_admin` | 23 |
| payroll/src/contract.rs:237 `invite_worker` | 17 |
| payroll/src/contract.rs:271 `revoke_invite` | 14 |
| payroll/src/contract.rs:302 `accept_invite` | 16 |
| payroll/src/contract.rs:352 `remove_worker` | 18 |
| payroll/src/contract.rs:385-391 `open_run` | 20 |
| payroll/src/contract.rs:448 `pay` (storage events, Vec input) | 15, 12 |
| payroll/src/contract.rs:510 `close_run` | 21 |
| payroll/src/contract.rs:573-580 and :579 `get_roster` | 9, 10 |
| auditor/src/contract.rs:40, 97, 140, 167 | 32, 29, 30, 31 |
| auditor/src/storage.rs:119 | 27 |

The new counters (`runs_opened`, `admin_changes`, memberships) use `checked_add` and fail with `CounterOverflow` (21); Scout reports no overflow finding for them. Tests: `open_run_refuses_when_runs_opened_is_at_its_limit`, `accept_admin_refuses_when_admin_changes_is_at_its_limit`, `accept_invite_refuses_a_first_join_when_the_membership_count_is_at_its_limit`.

## cargo audit

cargo audit 0.22.2 against `packages/contracts/Cargo.lock`: 0 vulnerabilities, 1 warning.

The warning is RUSTSEC-2024-0436: `paste` 1.0.15 is unmaintained. It is justified. `paste` is a compile-time macro crate that reaches us only through `soroban-env-host`, the native Soroban host the SDK links in for tests. It is absent from both wasm dependency graphs, so it never ships in a contract:

```
cargo tree --locked -p kalypso-payroll -e normal --target wasm32v1-none -i paste
cargo tree --locked -p kalypso-auditor -e normal --target wasm32v1-none -i paste
```

Both print `nothing to print`.

## How to rerun

- Scout: every push to `main` runs the `scout` job in `.github/workflows/ci.yml`. The full report appears in that run's summary page, and one annotation titled "Scout findings (N)" lists every finding on its own line. The report files are also uploaded as the `scout-report` artifact.
- clippy: the `contracts` job in the same workflow runs `cargo clippy -p kalypso-payroll --locked --all-targets -- -D warnings` and the same for `kalypso-auditor`.
- cargo audit: from `packages/contracts`, run `cargo install cargo-audit --version 0.22.2 --locked`, then `cargo audit`.

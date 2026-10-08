//! Shared setup for the payroll unit tests: a fresh test ledger with
//! testnet's storage lifetimes, the mock token, the real auditor registry,
//! and helpers that sign each call as exactly one address through
//! `mock_auths`. No unit test uses `mock_all_auths`, so a missing or wrong
//! signature always fails.
//!
//! Not covered by the unit tests: real proofs, the real token's balance and
//! proof checks, transaction size and CPU limits, and rent costs. M2c
//! integration and fork tests cover those against the real token.
extern crate std;

mod admin;
mod auth;
mod company;
mod events;
mod mock_token;
mod pay;
mod registry;
mod runs;
mod workers;

use soroban_sdk::{
    testutils::{
        storage::{Instance as _, Persistent as _, Temporary as _},
        Address as _, ContractEvents, EnvTestConfig, Events as _, Ledger, MockAuth,
        MockAuthInvoke,
    },
    xdr::{ContractEventBody, ScError, ScErrorCode, ScErrorType, ScVal},
    Address, Bytes, Env, Error, IntoVal, InvokeError, String, Symbol, Val, Vec,
};

use crate::storage::WorkerRecord;
use crate::{Company, Payroll, PayrollClient, PayrollError, Run, WorkerStatus};
use mock_token::{register_account, MockToken, MockTokenClient, RecordedTransfer};
use registry::{deploy_registry, owner_of, register_auditors_through};

/// Testnet's minimum entry lifetimes on 7 Oct 2026 (reference/stellar/now.md):
/// about 1 hour for temporary entries and about 7 days for persistent ones.
pub const TESTNET_MIN_TEMP_TTL: u32 = 720;
pub const TESTNET_MIN_PERSISTENT_TTL: u32 = 120_960;

pub const COMPANY_AUDITOR: u32 = 1;
pub const OTHER_AUDITOR: u32 = 2;
pub const WORKER_AUDITOR: u32 = 9;

pub struct Setup {
    pub e: Env,
    pub payroll: Address,
    pub token: Address,
    pub registry: Address,
}

/// A company with an admin registered under `COMPANY_AUDITOR` and active
/// workers registered under `WORKER_AUDITOR`.
pub struct Team {
    pub company_id: u64,
    pub admin: Address,
    pub workers: std::vec::Vec<Address>,
}

impl Setup {
    pub fn new() -> Self {
        // Snapshots are off so tests never write files outside src and tests.
        let e = Env::new_with_config(EnvTestConfig {
            capture_snapshot_at_drop: false,
        });
        e.ledger().set_sequence_number(1_000);
        e.ledger().set_min_temp_entry_ttl(TESTNET_MIN_TEMP_TTL);
        e.ledger()
            .set_min_persistent_entry_ttl(TESTNET_MIN_PERSISTENT_TTL);
        let token = e.register(MockToken, ());
        let registry = deploy_registry(&e);
        register_auditors_through(&e, &registry, OTHER_AUDITOR);
        let payroll = e.register(Payroll, (&token, &registry));
        Setup {
            e,
            payroll,
            token,
            registry,
        }
    }

    /// A second payroll on the same ledger, wired to `token` and `registry`
    /// instead, for the cases where one of them does not answer as expected.
    pub fn rewired(&self, token: &Address, registry: &Address) -> Setup {
        Setup {
            e: self.e.clone(),
            payroll: self.e.register(Payroll, (token, registry)),
            token: token.clone(),
            registry: registry.clone(),
        }
    }

    /// The owner of `auditor_id` in the registry: the accountant a company
    /// under that id must name.
    pub fn accountant(&self, auditor_id: u32) -> Address {
        owner_of(&self.e, &self.registry, auditor_id)
    }

    pub fn client(&self) -> PayrollClient<'_> {
        PayrollClient::new(&self.e, &self.payroll)
    }

    pub fn token_client(&self) -> MockTokenClient<'_> {
        MockTokenClient::new(&self.e, &self.token)
    }

    pub fn account(&self, auditor_id: u32) -> Address {
        let account = Address::generate(&self.e);
        register_account(&self.e, &self.token, &account, auditor_id);
        account
    }

    pub fn unregistered(&self) -> Address {
        Address::generate(&self.e)
    }

    pub fn text(&self, s: &str) -> String {
        String::from_str(&self.e, s)
    }

    pub fn seq(&self) -> u32 {
        self.e.ledger().sequence()
    }

    pub fn advance(&self, ledgers: u32) {
        self.e.ledger().set_sequence_number(self.seq() + ledgers);
    }

    /// Signs exactly one root call to the payroll contract as `signer`, with
    /// no nested calls.
    pub fn sign(&self, signer: &Address, fn_name: &str, args: Vec<Val>) {
        self.e.mock_auths(&[MockAuth {
            address: signer,
            invoke: &MockAuthInvoke {
                contract: &self.payroll,
                fn_name,
                args,
                sub_invokes: &[],
            },
        }]);
    }

    /// Signs a `pay` call as `signer`, covering one nested
    /// `confidential_transfer(treasury, worker, data)` per item.
    pub fn sign_pay(
        &self,
        signer: &Address,
        treasury: &Address,
        company_id: u64,
        run_id: u64,
        items: &Vec<(Address, Bytes)>,
    ) {
        let transfers: std::vec::Vec<MockAuthInvoke> = items
            .iter()
            .map(|(worker, data)| MockAuthInvoke {
                contract: &self.token,
                fn_name: "confidential_transfer",
                args: (treasury, worker, data).into_val(&self.e),
                sub_invokes: &[],
            })
            .collect();
        self.e.mock_auths(&[MockAuth {
            address: signer,
            invoke: &MockAuthInvoke {
                contract: &self.payroll,
                fn_name: "pay",
                args: (company_id, run_id, items.clone()).into_val(&self.e),
                sub_invokes: &transfers,
            },
        }]);
    }

    /// Names the registry's owner of `auditor_id` as the accountant.
    pub fn create_company(&self, admin: &Address, auditor_id: u32, label: &str) -> u64 {
        let label = self.text(label);
        let accountant = self.accountant(auditor_id);
        self.sign(
            admin,
            "create_company",
            (admin, &accountant, auditor_id, &label).into_val(&self.e),
        );
        self.client()
            .create_company(admin, &accountant, &auditor_id, &label)
    }

    /// Signs and tries `create_company` exactly as given, for refusals.
    pub fn try_create_company(
        &self,
        admin: &Address,
        accountant: &Address,
        auditor_id: u32,
        label: &String,
    ) -> Result<Result<u64, Error>, Result<Error, InvokeError>> {
        self.sign(
            admin,
            "create_company",
            (admin, accountant, auditor_id, label).into_val(&self.e),
        );
        self.client()
            .try_create_company(admin, accountant, &auditor_id, label)
    }

    pub fn invite(&self, company_id: u64, admin: &Address, worker: &Address) {
        self.sign(
            admin,
            "invite_worker",
            (company_id, worker).into_val(&self.e),
        );
        self.client().invite_worker(&company_id, worker);
    }

    pub fn accept(&self, company_id: u64, worker: &Address) {
        self.sign(
            worker,
            "accept_invite",
            (company_id, worker).into_val(&self.e),
        );
        self.client().accept_invite(&company_id, worker);
    }

    pub fn join(&self, company_id: u64, admin: &Address, worker: &Address) {
        self.invite(company_id, admin, worker);
        self.accept(company_id, worker);
    }

    pub fn remove(&self, company_id: u64, admin: &Address, worker: &Address) {
        self.sign(
            admin,
            "remove_worker",
            (company_id, worker).into_val(&self.e),
        );
        self.client().remove_worker(&company_id, worker);
    }

    pub fn revoke(&self, company_id: u64, admin: &Address, worker: &Address) {
        self.sign(
            admin,
            "revoke_invite",
            (company_id, worker).into_val(&self.e),
        );
        self.client().revoke_invite(&company_id, worker);
    }

    /// Writes a worker status straight into storage. Used only to set up a
    /// state the public functions refuse to reach, so a defence-in-depth
    /// check can be shown to hold on its own.
    pub fn force_worker_status(&self, company_id: u64, worker: &Address, status: WorkerStatus) {
        self.e.as_contract(&self.payroll, || {
            crate::storage::set_worker_record(
                &self.e,
                company_id,
                worker,
                &WorkerRecord {
                    status,
                    on_roster: false,
                },
            );
        });
    }

    /// Rewrites a company record straight in storage. Used only to put a
    /// counter at a limit that would take billions of real calls to reach, so
    /// the overflow check can be shown to hold.
    pub fn force_company(&self, company_id: u64, change: impl FnOnce(&mut Company)) {
        self.e.as_contract(&self.payroll, || {
            let mut company = crate::storage::company(&self.e, company_id).unwrap();
            change(&mut company);
            crate::storage::set_company(&self.e, company_id, &company);
        });
    }

    /// See `force_company`, for one run.
    pub fn force_run(&self, company_id: u64, run_id: u64, change: impl FnOnce(&mut Run)) {
        self.e.as_contract(&self.payroll, || {
            let mut run = crate::storage::run(&self.e, company_id, run_id).unwrap();
            change(&mut run);
            crate::storage::set_run(&self.e, company_id, run_id, &run);
        });
    }

    pub fn open_run(&self, company_id: u64, admin: &Address, run_id: u64, expected_count: u32) {
        let label = self.text("October 2026");
        self.sign(
            admin,
            "open_run",
            (company_id, run_id, &label, expected_count).into_val(&self.e),
        );
        self.client()
            .open_run(&company_id, &run_id, &label, &expected_count);
    }

    pub fn pay(&self, company_id: u64, run_id: u64, admin: &Address, items: &Vec<(Address, Bytes)>) {
        self.sign_pay(admin, admin, company_id, run_id, items);
        self.client().pay(&company_id, &run_id, items);
    }

    pub fn close_run(&self, company_id: u64, admin: &Address, run_id: u64) {
        self.sign(admin, "close_run", (company_id, run_id).into_val(&self.e));
        self.client().close_run(&company_id, &run_id);
    }

    pub fn propose_admin(
        &self,
        company_id: u64,
        admin: &Address,
        new_admin: &Address,
        live_until_ledger: u32,
    ) {
        self.sign(
            admin,
            "propose_admin",
            (company_id, new_admin, live_until_ledger).into_val(&self.e),
        );
        self.client()
            .propose_admin(&company_id, new_admin, &live_until_ledger);
    }

    pub fn accept_admin(&self, company_id: u64, new_admin: &Address) {
        self.sign(new_admin, "accept_admin", (company_id,).into_val(&self.e));
        self.client().accept_admin(&company_id);
    }

    /// A company named "Acme" with `n` active workers.
    pub fn team(&self, n: usize) -> Team {
        let admin = self.account(COMPANY_AUDITOR);
        let company_id = self.create_company(&admin, COMPANY_AUDITOR, "Acme");
        let workers: std::vec::Vec<Address> = (0..n)
            .map(|_| {
                let worker = self.account(WORKER_AUDITOR);
                self.join(company_id, &admin, &worker);
                worker
            })
            .collect();
        Team {
            company_id,
            admin,
            workers,
        }
    }

    /// One item per worker, each with its own data blob.
    pub fn items(&self, workers: &[&Address]) -> Vec<(Address, Bytes)> {
        let mut items = Vec::new(&self.e);
        for (i, worker) in workers.iter().enumerate() {
            let data = Bytes::from_array(&self.e, &[0xA0 + i as u8; 48]);
            items.push_back(((*worker).clone(), data));
        }
        items
    }

    pub fn transfers(&self) -> Vec<RecordedTransfer> {
        self.token_client().transfers()
    }

    /// Events the payroll contract emitted in the last call. Read this before
    /// any other call, because every call replaces it.
    pub fn payroll_events(&self) -> ContractEvents {
        self.e.events().all().filter_by_contract(&self.payroll)
    }

    /// Remaining lifetime of a persistent record, read as the contract.
    pub fn record_ttl(&self, key: Val) -> u32 {
        self.e
            .as_contract(&self.payroll, || self.e.storage().persistent().get_ttl(&key))
    }

    pub fn instance_ttl(&self) -> u32 {
        self.e
            .as_contract(&self.payroll, || self.e.storage().instance().get_ttl())
    }

    pub fn temporary_entry_count(&self) -> u32 {
        self.e
            .as_contract(&self.payroll, || self.e.storage().temporary().all().len())
    }

    /// Builds the storage key `DataKey::<variant>(fields)`. A contracttype
    /// enum variant is stored as a vector of its name followed by its fields,
    /// so this mirrors the private key type exactly.
    pub fn key<T: IntoVal<Env, Vec<Val>>>(&self, variant: &str, fields: T) -> Val {
        let mut key: Vec<Val> = Vec::new(&self.e);
        key.push_back(Symbol::new(&self.e, variant).into_val(&self.e));
        key.append(&fields.into_val(&self.e));
        key.into_val(&self.e)
    }
}

impl Setup {
    /// The host hands a `try_` caller every failure that is not a contract
    /// error, a missing signature included, as Error(Context, InvalidAction),
    /// and keeps the precise error only in that call's diagnostic events. So
    /// a signature failure is checked on both, which rules out any other
    /// host failure passing for it. Read this right after the call, because
    /// every call clears the event buffer.
    pub fn assert_auth_failed<T: core::fmt::Debug>(
        &self,
        result: Result<T, Result<Error, InvokeError>>,
    ) {
        match result {
            Err(Ok(error)) => assert_eq!(
                error,
                Error::from_type_and_code(ScErrorType::Context, ScErrorCode::InvalidAction)
            ),
            other => panic!("expected a signature failure, got {other:?}"),
        }
        let missing_signature = ScVal::Error(ScError::Auth(ScErrorCode::InvalidAction));
        let diagnostics = self.e.host().get_diagnostic_events().unwrap();
        assert!(
            diagnostics.0.iter().any(|event| match &event.event.body {
                ContractEventBody::V0(body) => body.topics.contains(&missing_signature),
            }),
            "the call failed, but not on a missing signature"
        );
    }
}

pub fn err(error: PayrollError) -> Error {
    error.into()
}

//! Attacks on the payroll contract that the per-function unit tests do not
//! make, each shown being refused. Two harnesses:
//!
//! - `Mock`: the mock token from src/test/mock_token.rs, for attacks on the
//!   payroll's own state machine and signatures.
//! - `Real`: the OpenZeppelin token wasm pinned in fixtures/, behind a verifier
//!   that accepts every proof, so the payroll's trust in the real token's
//!   answers, error codes and signature model is exercised against the exact
//!   code that runs on testnet.
//!
//! Both harnesses use the real kalypso-auditor registry, so create_company's
//! owner check reads the registry's own records.
//!
//! Not covered here: real proofs, fees, rent and transaction size.

#[allow(dead_code)]
#[path = "../src/test/mock_token.rs"]
mod mock_token;
#[allow(dead_code)]
#[path = "../src/test/registry.rs"]
mod registry;

use kalypso_auditor::AuditorRegistryClient;
use kalypso_payroll::{
    token, Payroll, PayrollClient, PayrollError, RunStatus, WorkerStatus, DAY_IN_LEDGERS,
    RECORD_EXTEND_TO,
};
use mock_token::{register_account, MockToken, MockTokenClient};
use registry::{deploy_registry, owner_of, register_auditor, register_auditors_through, GENERATOR};
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, EnvTestConfig, Events as _, Ledger, MockAuth, MockAuthInvoke},
    xdr::{ContractEventBody, ScError, ScErrorCode, ScErrorType, ScVal, ToXdr},
    Address, Bytes, BytesN, Env, Error, IntoVal, InvokeError, Map, String, Symbol, Val, Vec,
};

const COMPANY_AUDITOR: u32 = 1;
const OTHER_AUDITOR: u32 = 2;
const WORKER_AUDITOR: u32 = 9;

fn err(error: PayrollError) -> Error {
    error.into()
}

fn refused() -> Error {
    Error::from_type_and_code(ScErrorType::Context, ScErrorCode::InvalidAction)
}

/// What a `try_` call returns. The inner error type depends on the return
/// type: `()` and `u32` convert with `ConversionError`, `u64` with `Error`.
type Outcome<T, C = soroban_sdk::ConversionError> = Result<Result<T, C>, Result<Error, InvokeError>>;

fn failure<T: core::fmt::Debug, C: core::fmt::Debug>(outcome: Outcome<T, C>) -> Error {
    match outcome {
        Err(Ok(error)) => error,
        other => panic!("expected a failure with an error code, got {other:?}"),
    }
}

/// True when the last call's diagnostics carry `error`. A `try_` caller sees
/// every failure that is not its own contract's error, a missing signature
/// and a nested contract's error alike, as Error(Context, InvalidAction);
/// the precise error survives only in the diagnostic events of that call.
fn last_call_raised(e: &Env, error: ScError) -> bool {
    let wanted = ScVal::Error(error);
    e.host()
        .get_diagnostic_events()
        .unwrap()
        .0
        .iter()
        .any(|event| match &event.event.body {
            ContractEventBody::V0(body) => body.topics.contains(&wanted),
        })
}

fn last_call_failed_on_auth(e: &Env) -> bool {
    last_call_raised(e, ScError::Auth(ScErrorCode::InvalidAction))
}

fn new_env() -> Env {
    let e = Env::new_with_config(EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    e.ledger().set_sequence_number(1_000);
    e.ledger().set_min_temp_entry_ttl(720);
    e.ledger().set_min_persistent_entry_ttl(120_960);
    e
}

/// Signs exactly one root call on `contract` as `signer`, with the given
/// nested calls, replacing any earlier authorization.
fn sign_tree(e: &Env, signer: &Address, contract: &Address, fn_name: &str, args: Vec<Val>, sub: &[MockAuthInvoke]) {
    e.mock_auths(&[MockAuth {
        address: signer,
        invoke: &MockAuthInvoke {
            contract,
            fn_name,
            args,
            sub_invokes: sub,
        },
    }]);
}

struct Mock {
    e: Env,
    payroll: Address,
    token: Address,
    registry: Address,
}

struct Team {
    company_id: u64,
    admin: Address,
    workers: std::vec::Vec<Address>,
}

impl Mock {
    fn new() -> Self {
        let e = new_env();
        let token = e.register(MockToken, ());
        let registry = deploy_registry(&e);
        register_auditors_through(&e, &registry, OTHER_AUDITOR);
        let payroll = e.register(Payroll, (&token, &registry));
        Mock {
            e,
            payroll,
            token,
            registry,
        }
    }

    fn client(&self) -> PayrollClient<'_> {
        PayrollClient::new(&self.e, &self.payroll)
    }

    fn transfers(&self) -> u32 {
        MockTokenClient::new(&self.e, &self.token).transfers().len()
    }

    fn account(&self, auditor_id: u32) -> Address {
        let account = Address::generate(&self.e);
        register_account(&self.e, &self.token, &account, auditor_id);
        account
    }

    fn text(&self, s: &str) -> String {
        String::from_str(&self.e, s)
    }

    fn seq(&self) -> u32 {
        self.e.ledger().sequence()
    }

    fn advance(&self, ledgers: u32) {
        self.e.ledger().set_sequence_number(self.seq() + ledgers);
    }

    fn sign(&self, signer: &Address, fn_name: &str, args: Vec<Val>) {
        sign_tree(&self.e, signer, &self.payroll, fn_name, args, &[]);
    }

    fn sign_pay(&self, signer: &Address, treasury: &Address, company_id: u64, run_id: u64, items: &Vec<(Address, Bytes)>) {
        let transfers: std::vec::Vec<MockAuthInvoke> = items
            .iter()
            .map(|(worker, data)| MockAuthInvoke {
                contract: &self.token,
                fn_name: "confidential_transfer",
                args: (treasury, worker, data).into_val(&self.e),
                sub_invokes: &[],
            })
            .collect();
        sign_tree(
            &self.e,
            signer,
            &self.payroll,
            "pay",
            (company_id, run_id, items.clone()).into_val(&self.e),
            &transfers,
        );
    }

    /// Names the registry's owner of `auditor_id` as the accountant.
    fn create_company(&self, admin: &Address, auditor_id: u32, label: &str) -> u64 {
        let label = self.text(label);
        let accountant = owner_of(&self.e, &self.registry, auditor_id);
        self.sign(admin, "create_company", (admin, &accountant, auditor_id, &label).into_val(&self.e));
        self.client().create_company(admin, &accountant, &auditor_id, &label)
    }

    fn join(&self, company_id: u64, admin: &Address, worker: &Address) {
        self.sign(admin, "invite_worker", (company_id, worker).into_val(&self.e));
        self.client().invite_worker(&company_id, worker);
        self.sign(worker, "accept_invite", (company_id, worker).into_val(&self.e));
        self.client().accept_invite(&company_id, worker);
    }

    fn open_run(&self, company_id: u64, admin: &Address, run_id: u64, expected_count: u32) {
        let label = self.text("October 2026");
        self.sign(admin, "open_run", (company_id, run_id, &label, expected_count).into_val(&self.e));
        self.client().open_run(&company_id, &run_id, &label, &expected_count);
    }

    fn items(&self, workers: &[&Address]) -> Vec<(Address, Bytes)> {
        let mut items = Vec::new(&self.e);
        for (i, worker) in workers.iter().enumerate() {
            items.push_back(((*worker).clone(), Bytes::from_array(&self.e, &[0xA0 + i as u8; 48])));
        }
        items
    }

    fn pay(&self, company_id: u64, run_id: u64, admin: &Address, items: &Vec<(Address, Bytes)>) {
        self.sign_pay(admin, admin, company_id, run_id, items);
        self.client().pay(&company_id, &run_id, items);
    }

    fn try_pay(&self, company_id: u64, run_id: u64, admin: &Address, items: &Vec<(Address, Bytes)>) -> Outcome<()> {
        self.sign_pay(admin, admin, company_id, run_id, items);
        self.client().try_pay(&company_id, &run_id, items)
    }

    fn propose_admin(&self, company_id: u64, admin: &Address, new_admin: &Address, live_until: u32) {
        self.sign(admin, "propose_admin", (company_id, new_admin, live_until).into_val(&self.e));
        self.client().propose_admin(&company_id, new_admin, &live_until);
    }

    fn team(&self, n: usize) -> Team {
        let admin = self.account(COMPANY_AUDITOR);
        let company_id = self.create_company(&admin, COMPANY_AUDITOR, "Acme");
        let workers = (0..n)
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
}

/// C8: the paid flag is persistent, so even one full record lifetime plus a
/// day later, long after every entry the contract wrote would have expired
/// had it been temporary, a repeat pay is still refused as AlreadyPaid.
#[test]
fn refuses_repeat_pay_a_full_record_lifetime_after_the_first() {
    let m = Mock::new();
    let t = m.team(1);
    m.open_run(t.company_id, &t.admin, 7, 1);
    let items = m.items(&[&t.workers[0]]);
    m.pay(t.company_id, 7, &t.admin, &items);
    assert_eq!(m.transfers(), 1);

    m.advance(RECORD_EXTEND_TO + DAY_IN_LEDGERS);

    assert!(m.client().is_paid(&t.company_id, &7, &t.workers[0]));
    assert_eq!(failure(m.try_pay(t.company_id, 7, &t.admin, &items)), err(PayrollError::AlreadyPaid));
    assert_eq!(m.transfers(), 1);
    assert_eq!(m.client().get_run(&t.company_id, &7).paid_count, 1);
}

/// C6 with one treasury running two companies: a worker active in Acme is a
/// stranger to Acme Labs, so neither company's run can be used to pay them
/// through the other, and the paid flags never cross.
#[test]
fn refuses_paying_a_sister_companys_worker_from_the_same_treasury() {
    let m = Mock::new();
    let admin = m.account(COMPANY_AUDITOR);
    let acme = m.create_company(&admin, COMPANY_AUDITOR, "Acme");
    let labs = m.create_company(&admin, COMPANY_AUDITOR, "Acme Labs");
    let acme_worker = m.account(WORKER_AUDITOR);
    let labs_worker = m.account(WORKER_AUDITOR);
    m.join(acme, &admin, &acme_worker);
    m.join(labs, &admin, &labs_worker);
    m.open_run(acme, &admin, 7, 1);
    m.open_run(labs, &admin, 7, 1);

    let cross = m.items(&[&acme_worker]);
    assert_eq!(failure(m.try_pay(labs, 7, &admin, &cross)), err(PayrollError::NotActive));
    assert_eq!(m.transfers(), 0);

    m.pay(acme, 7, &admin, &cross);
    assert!(m.client().is_paid(&acme, &7, &acme_worker));
    assert!(!m.client().is_paid(&labs, &7, &acme_worker));
    assert_eq!(m.client().get_run(&labs, &7).paid_count, 0);
    assert_eq!(m.client().worker_status(&labs, &acme_worker), None);

    assert_eq!(failure(m.try_pay(labs, 7, &admin, &cross)), err(PayrollError::NotActive));
    assert_eq!(failure(m.try_pay(acme, 7, &admin, &cross)), err(PayrollError::AlreadyPaid));
    assert_eq!(m.transfers(), 1);
}

/// C4: a proposed admin has no power until they accept. Every admin call,
/// signed by the successor while the proposal is pending, fails on the
/// signature and changes nothing, including a pay that names the successor
/// as the treasury of the nested transfer.
#[test]
fn refuses_every_admin_call_signed_by_the_proposed_admin_before_acceptance() {
    let m = Mock::new();
    let t = m.team(1);
    m.open_run(t.company_id, &t.admin, 7, 1);
    let successor = m.account(COMPANY_AUDITOR);
    m.propose_admin(t.company_id, &t.admin, &successor, m.seq() + 100);
    let c = m.client();
    let id = t.company_id;
    let worker = &t.workers[0];
    let items = m.items(&[worker]);
    let label = m.text("November 2026");
    let newcomer = m.account(WORKER_AUDITOR);

    for treasury in [&successor, &t.admin] {
        m.sign_pay(&successor, treasury, id, 7, &items);
        assert_eq!(failure(c.try_pay(&id, &7, &items)), refused());
        assert!(last_call_failed_on_auth(&m.e));
    }
    m.sign(&successor, "close_run", (id, 7u64).into_val(&m.e));
    assert_eq!(failure(c.try_close_run(&id, &7)), refused());
    assert!(last_call_failed_on_auth(&m.e));
    m.sign(&successor, "open_run", (id, 8u64, &label, 1u32).into_val(&m.e));
    assert_eq!(failure(c.try_open_run(&id, &8, &label, &1)), refused());
    assert!(last_call_failed_on_auth(&m.e));
    m.sign(&successor, "invite_worker", (id, &newcomer).into_val(&m.e));
    assert_eq!(failure(c.try_invite_worker(&id, &newcomer)), refused());
    assert!(last_call_failed_on_auth(&m.e));
    m.sign(&successor, "remove_worker", (id, worker).into_val(&m.e));
    assert_eq!(failure(c.try_remove_worker(&id, worker)), refused());
    assert!(last_call_failed_on_auth(&m.e));
    m.sign(&successor, "propose_admin", (id, &successor, m.seq() + 10).into_val(&m.e));
    assert_eq!(failure(c.try_propose_admin(&id, &successor, &(m.seq() + 10))), refused());
    assert!(last_call_failed_on_auth(&m.e));
    m.sign(&successor, "cancel_admin_proposal", (id,).into_val(&m.e));
    assert_eq!(failure(c.try_cancel_admin_proposal(&id)), refused());
    assert!(last_call_failed_on_auth(&m.e));

    assert_eq!(m.transfers(), 0);
    assert!(!c.is_paid(&id, &7, worker));
    assert_eq!(c.get_run(&id, &7).status, RunStatus::Open);
    assert!(c.try_get_run(&id, &8).is_err());
    assert_eq!(c.worker_status(&id, &newcomer), None);
    assert_eq!(c.worker_status(&id, worker), Some(WorkerStatus::Active));
    assert_eq!(c.get_company(&id).admin, t.admin);
    assert_eq!(c.pending_admin(&id).map(|p| p.new_admin), Some(successor));
}

/// C44: a handover offer can never outlive the network's longest entry
/// lifetime, the same bound the auditor registry sets. A proposal with a
/// u32::MAX deadline is refused with InvalidLiveUntil and stores nothing, so
/// ten years on there is no offer for the successor to accept and the
/// company still belongs to its admin.
#[test]
fn refuses_an_admin_proposal_that_would_stay_acceptable_for_years() {
    let m = Mock::new();
    let t = m.team(0);
    let successor = m.account(COMPANY_AUDITOR);

    m.sign(&t.admin, "propose_admin", (t.company_id, &successor, u32::MAX).into_val(&m.e));
    assert_eq!(
        failure(m.client().try_propose_admin(&t.company_id, &successor, &u32::MAX)),
        err(PayrollError::InvalidLiveUntil)
    );
    assert_eq!(m.client().pending_admin(&t.company_id), None);

    m.advance(10 * 365 * DAY_IN_LEDGERS);

    m.sign(&successor, "accept_admin", (t.company_id,).into_val(&m.e));
    assert_eq!(
        failure(m.client().try_accept_admin(&t.company_id)),
        err(PayrollError::NoPendingAdmin)
    );
    assert_eq!(m.client().get_company(&t.company_id).admin, t.admin);
}

const TOKEN_WASM: &[u8] = include_bytes!("../../fixtures/confidential_token.wasm");

// The `data` bytes the client SDK builds for its pinned register vector
// (stellar-confidential-token-sdk 45178c4, packages/sdk/src/chain/test/vectors/register.hex,
// without the 8-byte scvBytes header around them), also used by the auditor
// crate's integration test. With an accepting verifier any account can
// register with it.
const SDK_REGISTER_DATA: &str = concat!(
    "0000001100000001000000020000000f000000077061796c6f6164000000001100000001000000020000000f",
    "0000000370766b000000000d0000004018f62b5252eeff6782dfd329542181786f22cb01ef40595e4f3e3009",
    "cdd5a364062e79a3cfc3c40e07345259cb432166e47449d01f2f3c723d9d426e242c35d20000000f00000001",
    "790000000000000d000000402d4a0d872d1283f202ce9f6049e84f42d8240295c57d362f21b35bc06bfcfa3e",
    "17ad641f6d6a5d7eeec9b49813a2bde13d8f9342ce51cd315aa399321e739c9e0000000f0000000570726f6f",
    "660000000000000d000000400707070707070707070707070707070707070707070707070707070707070707",
    "0707070707070707070707070707070707070707070707070707070707070707",
);

/// Canonical coordinates that are not on the curve: 2 squared is not 1 cubed minus 17.
const OFF_CURVE: [u8; 64] = {
    let mut p = [0u8; 64];
    p[31] = 1;
    p[63] = 2;
    p
};

/// Stands in for the UltraHonk verifier so no real proof is needed. The
/// circuit type arrives as a u32, which is how the token encodes its enum.
#[contract]
pub struct AcceptingVerifier;

#[contractimpl]
impl AcceptingVerifier {
    pub fn verify_proof(_e: Env, _circuit_type: u32, _public_inputs: Bytes, _proof: Bytes) -> bool {
        true
    }
}

fn hex_bytes(e: &Env, hex: &str) -> Bytes {
    let raw: std::vec::Vec<u8> = (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
        .collect();
    Bytes::from_slice(e, &raw)
}

struct Real {
    e: Env,
    payroll: Address,
    token: Address,
    registry: Address,
}

impl Real {
    fn new() -> Self {
        let e = new_env();
        let usdc = e.register_stellar_asset_contract_v2(Address::generate(&e));
        let verifier = e.register(AcceptingVerifier, ());
        let registry = deploy_registry(&e);
        register_auditors_through(&e, &registry, WORKER_AUDITOR);
        let token = e.register(TOKEN_WASM, (usdc.address(), verifier, registry.clone()));
        let payroll = e.register(Payroll, (&token, &registry));
        Real {
            e,
            payroll,
            token,
            registry,
        }
    }

    fn client(&self) -> PayrollClient<'_> {
        PayrollClient::new(&self.e, &self.payroll)
    }

    fn token_client(&self) -> token::Client<'_> {
        token::Client::new(&self.e, &self.token)
    }

    fn registry_client(&self) -> AuditorRegistryClient<'_> {
        AuditorRegistryClient::new(&self.e, &self.registry)
    }

    fn text(&self, s: &str) -> String {
        String::from_str(&self.e, s)
    }

    /// The real token's `register` for `account`, signed by the account.
    fn try_register(&self, account: &Address, auditor_id: u32) -> Outcome<()> {
        let data = hex_bytes(&self.e, SDK_REGISTER_DATA);
        sign_tree(
            &self.e,
            account,
            &self.token,
            "register",
            (account, auditor_id, &data).into_val(&self.e),
            &[],
        );
        self.token_client().try_register(account, &auditor_id, &data)
    }

    /// A fresh account registered with the real token under `auditor_id`.
    fn account(&self, auditor_id: u32) -> Address {
        let account = Address::generate(&self.e);
        assert_eq!(self.try_register(&account, auditor_id), Ok(Ok(())));
        account
    }

    /// Names the registry's owner of `auditor_id` as the accountant.
    fn try_create_company(&self, admin: &Address, auditor_id: u32, label: &str) -> Outcome<u64, Error> {
        let accountant = owner_of(&self.e, &self.registry, auditor_id);
        self.try_create_company_naming(admin, &accountant, auditor_id, label)
    }

    fn try_create_company_naming(
        &self,
        admin: &Address,
        accountant: &Address,
        auditor_id: u32,
        label: &str,
    ) -> Outcome<u64, Error> {
        let label = self.text(label);
        sign_tree(
            &self.e,
            admin,
            &self.payroll,
            "create_company",
            (admin, accountant, auditor_id, &label).into_val(&self.e),
            &[],
        );
        self.client()
            .try_create_company(admin, accountant, &auditor_id, &label)
    }

    fn team(&self, n: usize) -> Team {
        let admin = self.account(COMPANY_AUDITOR);
        let company_id = self
            .try_create_company(&admin, COMPANY_AUDITOR, "Acme")
            .unwrap()
            .unwrap();
        let workers = (0..n)
            .map(|_| {
                let worker = self.account(WORKER_AUDITOR);
                sign_tree(&self.e, &admin, &self.payroll, "invite_worker", (company_id, &worker).into_val(&self.e), &[]);
                self.client().invite_worker(&company_id, &worker);
                sign_tree(&self.e, &worker, &self.payroll, "accept_invite", (company_id, &worker).into_val(&self.e), &[]);
                self.client().accept_invite(&company_id, &worker);
                worker
            })
            .collect();
        Team {
            company_id,
            admin,
            workers,
        }
    }

    fn open_run(&self, company_id: u64, admin: &Address, run_id: u64, expected_count: u32) {
        let label = self.text("October 2026");
        sign_tree(
            &self.e,
            admin,
            &self.payroll,
            "open_run",
            (company_id, run_id, &label, expected_count).into_val(&self.e),
            &[],
        );
        self.client().open_run(&company_id, &run_id, &label, &expected_count);
    }

    /// The XDR the real token decodes as TransferData: every scalar zero,
    /// R_e the identity, and the two commitments as given. With the accepting
    /// verifier only the token's own decoding and point checks remain.
    fn transfer_data(&self, c_spend_new: &[u8; 64], c_transfer: &[u8; 64]) -> Bytes {
        let e = &self.e;
        let zero = BytesN::<32>::from_array(e, &[0u8; 32]);
        let identity = BytesN::<64>::from_array(e, &[0u8; 64]);
        let mut payload: Map<Symbol, Val> = Map::new(e);
        payload.set(Symbol::new(e, "c_spend_new"), BytesN::<64>::from_array(e, c_spend_new).into_val(e));
        payload.set(Symbol::new(e, "c_transfer"), BytesN::<64>::from_array(e, c_transfer).into_val(e));
        payload.set(Symbol::new(e, "r_e_point"), identity.into_val(e));
        for field in [
            "v_tilde",
            "b_tilde",
            "sigma",
            "v_tilde_aud_r",
            "r_tilde_aud_r",
            "v_tilde_aud_s",
            "b_tilde_aud_s",
        ] {
            payload.set(Symbol::new(e, field), zero.clone().into_val(e));
        }
        let mut data: Map<Symbol, Val> = Map::new(e);
        data.set(Symbol::new(e, "payload"), payload.into_val(e));
        data.set(Symbol::new(e, "proof"), Bytes::new(e).into_val(e));
        data.to_xdr(e)
    }

    fn sign_pay(&self, signer: &Address, treasury: &Address, company_id: u64, run_id: u64, items: &Vec<(Address, Bytes)>) {
        let transfers: std::vec::Vec<MockAuthInvoke> = items
            .iter()
            .map(|(worker, data)| MockAuthInvoke {
                contract: &self.token,
                fn_name: "confidential_transfer",
                args: (treasury, worker, data).into_val(&self.e),
                sub_invokes: &[],
            })
            .collect();
        sign_tree(
            &self.e,
            signer,
            &self.payroll,
            "pay",
            (company_id, run_id, items.clone()).into_val(&self.e),
            &transfers,
        );
    }

    fn try_pay(&self, company_id: u64, run_id: u64, admin: &Address, items: &Vec<(Address, Bytes)>) -> Outcome<()> {
        self.sign_pay(admin, admin, company_id, run_id, items);
        self.client().try_pay(&company_id, &run_id, items)
    }

    fn receiving(&self, account: &Address) -> BytesN<64> {
        self.token_client().confidential_balance(account).receiving_commitment
    }

    fn payroll_event_count(&self) -> usize {
        self.e.events().all().filter_by_contract(&self.payroll).events().len()
    }

    /// Everything a failed pay must leave untouched.
    fn assert_untouched(&self, t: &Team, run_id: u64) {
        assert_eq!(self.payroll_event_count(), 0);
        for worker in &t.workers {
            assert!(!self.client().is_paid(&t.company_id, &run_id, worker));
            assert_eq!(self.receiving(worker), BytesN::from_array(&self.e, &[0u8; 64]));
        }
        assert_eq!(self.client().get_run(&t.company_id, &run_id).paid_count, 0);
    }
}

/// C9 against the real token: the payroll reads the treasury's registration
/// through the real `confidential_balance`, so an address the token has no
/// account for is refused with the token's 3501 mapped to
/// NotRegisteredWithToken, and no company is created.
#[test]
fn refuses_create_company_for_a_treasury_the_real_token_does_not_know() {
    let r = Real::new();
    let stranger = Address::generate(&r.e);

    assert_eq!(
        failure(r.try_create_company(&stranger, COMPANY_AUDITOR, "Ghost")),
        err(PayrollError::NotRegisteredWithToken)
    );
    assert_eq!(r.client().company_count(), 0);
}

/// C9 against the real token: the auditor id named at creation must equal
/// the id the real token recorded at registration.
#[test]
fn refuses_create_company_under_an_auditor_id_other_than_the_real_registration() {
    let r = Real::new();
    let treasury = r.account(OTHER_AUDITOR);

    assert_eq!(
        failure(r.try_create_company(&treasury, COMPANY_AUDITOR, "Acme")),
        err(PayrollError::AuditorMismatch)
    );
    assert_eq!(r.client().company_count(), 0);
    assert_eq!(r.try_create_company(&treasury, OTHER_AUDITOR, "Acme"), Ok(Ok(0)));
}

/// C43 with the real token and the real registry. Ids are handed out in
/// call order and the token binds an account to a bare number. An app that
/// predicts the accountant's id as `key_count()` before the accountant's own
/// `register_key` lands loses that id to whoever registers first, and a
/// treasury that then registers under it is bound to the front-runner's key
/// for good: the token refuses a second registration. create_company now
/// asks the registry who owns the id, so that treasury can never become a
/// company naming the real accountant, under either id, and this payroll
/// never sends a salary encrypted to the front-runner's key. The control: a
/// treasury registered under the id the accountant's confirmed
/// `register_key` returned is accepted.
#[test]
fn refuses_a_company_whose_treasury_is_bound_to_a_front_runners_auditor_id() {
    let r = Real::new();
    let attacker = Address::generate(&r.e);
    let accountant = Address::generate(&r.e);
    let predicted = r.registry_client().key_count();

    let attacker_id = register_auditor(&r.e, &r.registry, &attacker);
    let accountant_id = register_auditor(&r.e, &r.registry, &accountant);
    let treasury = r.account(predicted);

    assert_eq!(attacker_id, predicted);
    assert_eq!(accountant_id, predicted + 1);
    assert_eq!(r.token_client().confidential_balance(&treasury).auditor_id, attacker_id);
    assert_eq!(r.registry_client().owner_of(&attacker_id), attacker);
    assert_eq!(
        failure(r.try_register(&treasury, accountant_id)),
        Error::from(token::ConfidentialTokenError::AccountAlreadyRegistered)
    );

    assert_eq!(
        failure(r.try_create_company_naming(&treasury, &accountant, predicted, "Acme")),
        err(PayrollError::AuditorNotOwnedByAccountant)
    );
    assert_eq!(r.payroll_event_count(), 0);
    assert_eq!(
        failure(r.try_create_company_naming(&treasury, &accountant, accountant_id, "Acme")),
        err(PayrollError::AuditorMismatch)
    );
    assert_eq!(r.client().company_count(), 0);

    let honest = r.account(accountant_id);
    assert_eq!(
        r.try_create_company_naming(&honest, &accountant, accountant_id, "Acme"),
        Ok(Ok(0))
    );
    assert_eq!(r.client().get_company(&0).accountant, accountant);
}

/// C5 and C7 against the real token. The control: one pay with a decodable
/// payload lands, the real token folds the commitment into the worker's
/// receiving balance and the paid flag is set. Then the same worker is
/// refused in the same run, with nothing more reaching the token.
#[test]
fn refuses_a_second_pay_after_a_real_token_transfer_landed() {
    let r = Real::new();
    let t = r.team(2);
    r.open_run(t.company_id, &t.admin, 7, 2);
    let data = r.transfer_data(&[0u8; 64], &GENERATOR);
    let mut items = Vec::new(&r.e);
    items.push_back((t.workers[0].clone(), data.clone()));

    assert_eq!(r.try_pay(t.company_id, 7, &t.admin, &items), Ok(Ok(())));

    // Read before any other call, because every call replaces the buffer.
    assert_eq!(r.payroll_event_count(), 1);
    assert!(r.client().is_paid(&t.company_id, &7, &t.workers[0]));
    assert_eq!(r.receiving(&t.workers[0]), BytesN::from_array(&r.e, &GENERATOR));

    let mut again = Vec::new(&r.e);
    again.push_back((t.workers[1].clone(), data.clone()));
    again.push_back((t.workers[0].clone(), data));
    assert_eq!(failure(r.try_pay(t.company_id, 7, &t.admin, &again)), err(PayrollError::AlreadyPaid));
    assert_eq!(r.receiving(&t.workers[0]), BytesN::from_array(&r.e, &GENERATOR));
    assert_eq!(r.receiving(&t.workers[1]), BytesN::from_array(&r.e, &[0u8; 64]));
    assert!(!r.client().is_paid(&t.company_id, &7, &t.workers[1]));
    assert_eq!(r.client().get_run(&t.company_id, &7).paid_count, 1);
}

/// C5 against the real token: the admin's signature over the root `pay`
/// alone does not move money, because the real token demands the treasury's
/// signature over each nested transfer, and the failed call leaves no flag,
/// no event and no balance change.
#[test]
fn refuses_pay_when_the_real_token_sees_no_signature_for_the_nested_transfer() {
    let r = Real::new();
    let t = r.team(1);
    r.open_run(t.company_id, &t.admin, 7, 1);
    let mut items = Vec::new(&r.e);
    items.push_back((t.workers[0].clone(), r.transfer_data(&[0u8; 64], &GENERATOR)));

    sign_tree(
        &r.e,
        &t.admin,
        &r.payroll,
        "pay",
        (t.company_id, 7u64, items.clone()).into_val(&r.e),
        &[],
    );
    assert_eq!(failure(r.client().try_pay(&t.company_id, &7, &items)), refused());
    assert!(last_call_failed_on_auth(&r.e));
    r.assert_untouched(&t, 7);
}

/// C8 against the real token. Bytes that are not XDR trap in the host's
/// deserializer (Error(Value, InvalidInput), which a `try_` caller sees
/// narrowed to Context/InvalidAction) before the token's own InvalidData
/// mapping runs; a transfer commitment that is not on the curve fails in
/// OpenZeppelin's Grumpkin arithmetic (InvalidPoint, 1403, which reaches the
/// caller unchanged). Both happen after the payroll has written the paid flag
/// and the run count, and after a valid first item's transfer already ran,
/// and the whole call is undone: no flag, no event, no balance change for
/// either worker.
#[test]
fn refuses_pay_whose_payload_the_real_token_rejects_and_leaves_no_trace() {
    let r = Real::new();
    let t = r.team(2);
    r.open_run(t.company_id, &t.admin, 7, 2);
    let good = r.transfer_data(&[0u8; 64], &GENERATOR);
    let garbage = Bytes::from_array(&r.e, &[0xAA; 48]);
    let off_curve = r.transfer_data(&[0u8; 64], &OFF_CURVE);

    for (bad, raised, seen_by_caller) in [
        (garbage, ScError::Value(ScErrorCode::InvalidInput), refused()),
        (off_curve, ScError::Contract(1403), Error::from_contract_error(1403)),
    ] {
        let mut items = Vec::new(&r.e);
        items.push_back((t.workers[0].clone(), good.clone()));
        items.push_back((t.workers[1].clone(), bad));
        assert_eq!(failure(r.try_pay(t.company_id, 7, &t.admin, &items)), seen_by_caller);
        assert!(!last_call_failed_on_auth(&r.e), "the token, not a signature, must refuse");
        assert!(last_call_raised(&r.e, raised.clone()), "expected {raised:?}");
        r.assert_untouched(&t, 7);
    }
}

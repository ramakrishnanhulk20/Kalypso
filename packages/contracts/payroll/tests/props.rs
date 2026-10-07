//! Property test: random sequences of payroll actions across two companies,
//! four workers and two run ids per company, checked after every step.
//!
//! After each step it asserts that no (company, run, worker) was ever paid
//! twice (C7); that the company the step did not target is unchanged (C6);
//! that each run's paid_count equals the PayslipIssued events seen for it and
//! never exceeds expected_count (C8); and that every new transfer came from
//! that company's admin at that moment and went to a worker active there at
//! that moment, never to the admin itself (C5). It also checks each call's
//! exact result, and the whole readable state of both companies, against a
//! model. One admin candidate per company is also one of the workers, so the
//! WorkerIsAdmin refusals in invite, accept, pay and handover are exercised.
//!
//! Not covered here: real proofs and the real token, wrong signers other than
//! another company's admin, storage lifetimes and transaction limits. The unit
//! tests in src/test cover those on the mock; M2c integration and fork tests
//! cover the real token on testnet.

// The include compiles the whole mock and its generated client; this file
// uses only part of them.
#[allow(dead_code)]
#[path = "../src/test/mock_token.rs"]
mod mock_token;

use kalypso_payroll::{
    Company, PayrollClient, PayrollError, PayslipIssued, PendingAdmin, Run, RunStatus,
    WorkerStatus,
};
use mock_token::{register_account, MockToken, MockTokenClient};
use proptest::prelude::*;
use soroban_sdk::{
    testutils::{
        Address as _, EnvTestConfig, Events as _, Ledger, MockAuth, MockAuthInvoke,
    },
    xdr::{ContractEvent, ContractEventBody, ScError, ScErrorCode, ScErrorType, ScVal},
    Address, Bytes, Env, Error, Event as _, IntoVal, InvokeError, String, Val,
};

const SLOTS: usize = 2;
const WORKERS: usize = 4;
const RUN_IDS: [u64; 2] = [7, 8];
const RUNS: usize = RUN_IDS.len();
/// Per company: 0 founding admin, 1 successor, 2 registered under the other
/// company's auditor id, 3 not registered with the token, 4 the worker whose
/// index equals the company's slot, registered under the company's auditor id.
const CANDIDATES: usize = 5;
const MISMATCHED: usize = 2;
const UNREGISTERED: usize = 3;
const WORKER_CANDIDATE: usize = 4;
const AUDITOR: [u32; SLOTS] = [1, 2];
const WORKER_AUDITOR: u32 = 9;

#[derive(Clone, Debug)]
enum Op {
    Create(usize),
    Invite(usize, usize),
    Revoke(usize, usize),
    Accept(usize, usize),
    Remove(usize, usize),
    Open(usize, usize, u32),
    Pay(usize, usize, Vec<usize>),
    Close(usize, usize),
    ProposeAdmin(usize, usize, u32),
    CancelAdmin(usize),
    AcceptAdmin(usize),
    Advance(u32),
    /// The other company's admin signs a call on this company: 0 pay,
    /// 1 close_run, 2 open_run, 3 invite_worker, 4 remove_worker,
    /// 5 revoke_invite.
    Foreign(usize, usize, u8),
}

impl Op {
    fn target(&self) -> Option<usize> {
        match *self {
            Op::Create(s)
            | Op::Invite(s, _)
            | Op::Revoke(s, _)
            | Op::Accept(s, _)
            | Op::Remove(s, _)
            | Op::Open(s, _, _)
            | Op::Pay(s, _, _)
            | Op::Close(s, _)
            | Op::ProposeAdmin(s, _, _)
            | Op::CancelAdmin(s)
            | Op::AcceptAdmin(s)
            | Op::Foreign(s, _, _) => Some(s),
            Op::Advance(_) => None,
        }
    }
}

fn op() -> impl Strategy<Value = Op> {
    let slot = 0..SLOTS;
    let worker = 0..WORKERS;
    let run = 0..RUNS;
    prop_oneof![
        1 => slot.clone().prop_map(Op::Create),
        4 => (slot.clone(), worker.clone()).prop_map(|(s, w)| Op::Invite(s, w)),
        2 => (slot.clone(), worker.clone()).prop_map(|(s, w)| Op::Revoke(s, w)),
        4 => (slot.clone(), worker.clone()).prop_map(|(s, w)| Op::Accept(s, w)),
        2 => (slot.clone(), worker.clone()).prop_map(|(s, w)| Op::Remove(s, w)),
        2 => (slot.clone(), run.clone(), 0u32..=4).prop_map(|(s, r, n)| Op::Open(s, r, n)),
        8 => (slot.clone(), run.clone(), prop::collection::vec(worker, 1..=2))
            .prop_map(|(s, r, ws)| Op::Pay(s, r, ws)),
        2 => (slot.clone(), run.clone()).prop_map(|(s, r)| Op::Close(s, r)),
        2 => (slot.clone(), 0..CANDIDATES, 0u32..=60)
            .prop_map(|(s, c, window)| Op::ProposeAdmin(s, c, window)),
        1 => slot.clone().prop_map(Op::CancelAdmin),
        2 => slot.clone().prop_map(Op::AcceptAdmin),
        1 => (1u32..=80).prop_map(Op::Advance),
        2 => (slot, run, 0u8..6).prop_map(|(s, r, k)| Op::Foreign(s, r, k)),
    ]
}

/// Purely random sequences almost never reach a paid run, because a run
/// needs a company, accepted workers and an open run first. So each case
/// starts with a random warm-up made of the same actions: both companies sign
/// up in random order, random workers are invited and accept, and every run
/// id tries to open with a random expected count. The random tail then does
/// everything else.
fn sequence() -> impl Strategy<Value = Vec<Op>> {
    let warm_up = (
        any::<bool>(),
        prop::collection::vec((0..SLOTS, 0..WORKERS), 3..9),
        prop::collection::vec(1u32..=3, SLOTS * RUNS),
    )
        .prop_map(|(second_first, joins, expected_counts)| {
            let mut ops = if second_first {
                vec![Op::Create(1), Op::Create(0)]
            } else {
                vec![Op::Create(0), Op::Create(1)]
            };
            for (s, w) in joins {
                ops.push(Op::Invite(s, w));
                ops.push(Op::Accept(s, w));
            }
            for (i, expected) in expected_counts.into_iter().enumerate() {
                ops.push(Op::Open(i / RUNS, i % RUNS, expected));
            }
            ops
        });
    (warm_up, prop::collection::vec(op(), 1..48)).prop_map(|(mut ops, tail)| {
        ops.extend(tail);
        ops
    })
}

#[derive(Clone, Debug)]
struct RunModel {
    open: bool,
    expected: u32,
    paid: [bool; WORKERS],
    paid_count: u32,
    opened_ledger: u32,
}

#[derive(Clone, Debug)]
struct CompanyModel {
    id: u64,
    admin: usize,
    pending: Option<(usize, u32)>,
    status: [Option<WorkerStatus>; WORKERS],
    roster: Vec<usize>,
    active: u32,
    runs: [Option<RunModel>; RUNS],
    created_ledger: u32,
}

#[derive(Clone, Debug, Default)]
struct Model {
    companies: [Option<CompanyModel>; SLOTS],
    next_id: u64,
}

fn context_error() -> Error {
    Error::from_type_and_code(ScErrorType::Context, ScErrorCode::InvalidAction)
}

fn fail(error: PayrollError) -> Result<Vec<usize>, Error> {
    Err(error.into())
}

/// The contract's expected answer to `op`, in the same order of checks the
/// contract makes. Returns the workers paid, in order. On error the caller
/// keeps the old model, because a failed call changes nothing.
fn predict(company: &mut CompanyModel, op: &Op, seq: u32) -> Result<Vec<usize>, Error> {
    // The worker index that is this company's admin right now, if any.
    let admin_worker = (company.admin == WORKER_CANDIDATE).then(|| op.target().unwrap());
    match *op {
        Op::Create(_) | Op::Advance(_) => unreachable!(),
        Op::Invite(_, w) if admin_worker == Some(w) => fail(PayrollError::WorkerIsAdmin),
        Op::Invite(_, w) => match company.status[w] {
            Some(WorkerStatus::Invited) | Some(WorkerStatus::Active) => {
                fail(PayrollError::AlreadyMember)
            }
            _ => {
                company.status[w] = Some(WorkerStatus::Invited);
                Ok(vec![])
            }
        },
        Op::Revoke(_, w) => {
            if company.status[w] != Some(WorkerStatus::Invited) {
                return fail(PayrollError::InviteNotFound);
            }
            company.status[w] = Some(WorkerStatus::Removed);
            Ok(vec![])
        }
        Op::Accept(_, w) => {
            if admin_worker == Some(w) {
                return fail(PayrollError::WorkerIsAdmin);
            }
            if company.status[w] != Some(WorkerStatus::Invited) {
                return fail(PayrollError::InviteNotFound);
            }
            company.status[w] = Some(WorkerStatus::Active);
            if !company.roster.contains(&w) {
                company.roster.push(w);
            }
            company.active += 1;
            Ok(vec![])
        }
        Op::Remove(_, w) => {
            if company.status[w] != Some(WorkerStatus::Active) {
                return fail(PayrollError::NotActive);
            }
            company.status[w] = Some(WorkerStatus::Removed);
            company.active -= 1;
            Ok(vec![])
        }
        Op::Open(_, r, expected) => {
            if company.runs[r].is_some() {
                return fail(PayrollError::RunExists);
            }
            if expected == 0 || expected > company.active {
                return fail(PayrollError::ExpectedCountInvalid);
            }
            company.runs[r] = Some(RunModel {
                open: true,
                expected,
                paid: [false; WORKERS],
                paid_count: 0,
                opened_ledger: seq,
            });
            Ok(vec![])
        }
        Op::Pay(_, r, ref workers) => {
            let status = company.status;
            let run = match company.runs[r].as_mut() {
                None => return fail(PayrollError::RunNotFound),
                Some(run) if !run.open => return fail(PayrollError::RunNotOpen),
                Some(run) => run,
            };
            for &w in workers {
                if admin_worker == Some(w) {
                    return fail(PayrollError::WorkerIsAdmin);
                }
                if status[w] != Some(WorkerStatus::Active) {
                    return fail(PayrollError::NotActive);
                }
                if run.paid[w] {
                    return fail(PayrollError::AlreadyPaid);
                }
                run.paid[w] = true;
                run.paid_count += 1;
                if run.paid_count > run.expected {
                    return fail(PayrollError::ExpectedCountExceeded);
                }
            }
            Ok(workers.clone())
        }
        Op::Close(_, r) => match company.runs[r].as_mut() {
            None => fail(PayrollError::RunNotFound),
            Some(run) if !run.open => fail(PayrollError::RunNotOpen),
            Some(run) => {
                run.open = false;
                Ok(vec![])
            }
        },
        Op::ProposeAdmin(_, candidate, window) => {
            if window == 0 {
                return fail(PayrollError::InvalidLiveUntil);
            }
            company.pending = Some((candidate, seq + window));
            Ok(vec![])
        }
        Op::CancelAdmin(_) => {
            if company.pending.is_none() {
                return fail(PayrollError::NoPendingAdmin);
            }
            company.pending = None;
            Ok(vec![])
        }
        Op::AcceptAdmin(_) => {
            let Some((candidate, live_until)) = company.pending else {
                return fail(PayrollError::NoPendingAdmin);
            };
            if seq > live_until {
                return fail(PayrollError::AdminTransferExpired);
            }
            if candidate == WORKER_CANDIDATE {
                let w = op.target().unwrap();
                if matches!(
                    company.status[w],
                    Some(WorkerStatus::Invited) | Some(WorkerStatus::Active)
                ) {
                    return fail(PayrollError::WorkerIsAdmin);
                }
            }
            if candidate == UNREGISTERED {
                return fail(PayrollError::NotRegisteredWithToken);
            }
            if candidate == MISMATCHED {
                return fail(PayrollError::AuditorMismatch);
            }
            company.admin = candidate;
            company.pending = None;
            Ok(vec![])
        }
        Op::Foreign(..) => Err(context_error()),
    }
}

#[derive(Clone, Debug, PartialEq)]
struct Snapshot {
    company: Company,
    runs: [Option<Run>; RUNS],
    paid: [[bool; WORKERS]; RUNS],
    status: [Option<WorkerStatus>; WORKERS],
    pending: Option<PendingAdmin>,
    roster: soroban_sdk::Vec<Address>,
}

struct World {
    e: Env,
    payroll: Address,
    token: Address,
    candidates: [[Address; CANDIDATES]; SLOTS],
    workers: [Address; WORKERS],
}

impl World {
    fn new() -> Self {
        let e = Env::new_with_config(EnvTestConfig {
            capture_snapshot_at_drop: false,
        });
        e.ledger().set_sequence_number(1_000);
        e.ledger().set_min_persistent_entry_ttl(120_960);
        let token = e.register(MockToken, ());
        let payroll = e.register(kalypso_payroll::Payroll, (&token,));
        // Workers 0 and 1 are registered under company 0's and company 1's
        // auditor id, so each can also be handed its company.
        let workers: [Address; WORKERS] = core::array::from_fn(|w| {
            let account = Address::generate(&e);
            let auditor_id = if w < SLOTS { AUDITOR[w] } else { WORKER_AUDITOR };
            register_account(&e, &token, &account, auditor_id);
            account
        });
        let candidates: [[Address; CANDIDATES]; SLOTS] = core::array::from_fn(|slot| {
            core::array::from_fn(|candidate| {
                if candidate == WORKER_CANDIDATE {
                    return workers[slot].clone();
                }
                let account = Address::generate(&e);
                match candidate {
                    MISMATCHED => register_account(&e, &token, &account, AUDITOR[1 - slot]),
                    UNREGISTERED => {}
                    _ => register_account(&e, &token, &account, AUDITOR[slot]),
                }
                account
            })
        });
        World {
            e,
            payroll,
            token,
            candidates,
            workers,
        }
    }

    fn client(&self) -> PayrollClient<'_> {
        PayrollClient::new(&self.e, &self.payroll)
    }

    fn seq(&self) -> u32 {
        self.e.ledger().sequence()
    }

    fn label(&self, slot: usize) -> String {
        String::from_str(&self.e, ["Acme", "Beta"][slot])
    }

    fn period(&self) -> String {
        String::from_str(&self.e, "October 2026")
    }

    fn sign(&self, signer: &Address, fn_name: &str, args: soroban_sdk::Vec<Val>) {
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

    fn sign_pay(
        &self,
        signer: &Address,
        company_id: u64,
        run_id: u64,
        items: &soroban_sdk::Vec<(Address, Bytes)>,
    ) {
        let transfers: Vec<MockAuthInvoke> = items
            .iter()
            .map(|(worker, data)| MockAuthInvoke {
                contract: &self.token,
                fn_name: "confidential_transfer",
                args: (signer, worker, data).into_val(&self.e),
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

    /// Distinct bytes per (company, run, worker, step), so a recorded
    /// transfer can be matched to the item it came from.
    fn items(
        &self,
        slot: usize,
        r: usize,
        workers: &[usize],
        step: usize,
    ) -> soroban_sdk::Vec<(Address, Bytes)> {
        let mut items = soroban_sdk::Vec::new(&self.e);
        for &w in workers {
            let data = Bytes::from_array(&self.e, &[slot as u8, r as u8, w as u8, step as u8]);
            items.push_back((self.workers[w].clone(), data));
        }
        items
    }

    fn snapshot(&self, company_id: u64) -> Snapshot {
        let c = self.client();
        Snapshot {
            company: c.get_company(&company_id),
            runs: RUN_IDS.map(|run_id| match c.try_get_run(&company_id, &run_id) {
                Ok(run) => Some(run.unwrap()),
                Err(error) => {
                    assert_eq!(error, Ok(PayrollError::RunNotFound.into()));
                    None
                }
            }),
            paid: RUN_IDS.map(|run_id| {
                core::array::from_fn(|w| c.is_paid(&company_id, &run_id, &self.workers[w]))
            }),
            status: core::array::from_fn(|w| c.worker_status(&company_id, &self.workers[w])),
            pending: c.pending_admin(&company_id),
            roster: c.get_roster(&company_id, &0, &50),
        }
    }

    fn expected_snapshot(&self, slot: usize, company: &CompanyModel) -> Snapshot {
        let mut roster = soroban_sdk::Vec::new(&self.e);
        for &w in &company.roster {
            roster.push_back(self.workers[w].clone());
        }
        Snapshot {
            company: Company {
                admin: self.candidates[slot][company.admin].clone(),
                auditor_id: AUDITOR[slot],
                label: self.label(slot),
                created_ledger: company.created_ledger,
                active_workers: company.active,
                roster_len: company.roster.len() as u32,
            },
            runs: core::array::from_fn(|r| {
                company.runs[r].as_ref().map(|run| Run {
                    status: if run.open {
                        RunStatus::Open
                    } else {
                        RunStatus::Closed
                    },
                    period_label: self.period(),
                    expected_count: run.expected,
                    paid_count: run.paid_count,
                    opened_ledger: run.opened_ledger,
                })
            }),
            paid: core::array::from_fn(|r| {
                company.runs[r]
                    .as_ref()
                    .map_or([false; WORKERS], |run| run.paid)
            }),
            status: company.status,
            pending: company.pending.map(|(candidate, live_until_ledger)| PendingAdmin {
                new_admin: self.candidates[slot][candidate].clone(),
                live_until_ledger,
            }),
            roster,
        }
    }

    fn call_failed_on_auth(&self) -> bool {
        let missing_signature = ScVal::Error(ScError::Auth(ScErrorCode::InvalidAction));
        self.e
            .host()
            .get_diagnostic_events()
            .unwrap()
            .0
            .iter()
            .any(|event| match &event.event.body {
                ContractEventBody::V0(body) => body.topics.contains(&missing_signature),
            })
    }
}

fn flatten<T: core::fmt::Debug, C: core::fmt::Debug>(
    result: Result<Result<T, C>, Result<Error, InvokeError>>,
) -> Result<(), Error> {
    match result {
        Ok(Ok(_)) => Ok(()),
        Err(Ok(error)) => Err(error),
        other => panic!("unexpected call result {other:?}"),
    }
}

/// Makes the real call for `op`, signed by whoever the model says should
/// sign it, except for `Foreign`, which another company's admin signs.
fn call(world: &World, model: &Model, op: &Op, step: usize) -> Result<(), Error> {
    let c = world.client();
    let e = &world.e;
    let seq = world.seq();
    let company = |slot: usize| model.companies[slot].as_ref().unwrap();
    let admin = |slot: usize| &world.candidates[slot][company(slot).admin];
    match *op {
        Op::Create(slot) => {
            let founder = &world.candidates[slot][0];
            let label = world.label(slot);
            world.sign(founder, "create_company", (founder, AUDITOR[slot], &label).into_val(e));
            flatten(c.try_create_company(founder, &AUDITOR[slot], &label))
        }
        Op::Invite(slot, w) => {
            let id = company(slot).id;
            world.sign(admin(slot), "invite_worker", (id, &world.workers[w]).into_val(e));
            flatten(c.try_invite_worker(&id, &world.workers[w]))
        }
        Op::Revoke(slot, w) => {
            let id = company(slot).id;
            world.sign(admin(slot), "revoke_invite", (id, &world.workers[w]).into_val(e));
            flatten(c.try_revoke_invite(&id, &world.workers[w]))
        }
        Op::Accept(slot, w) => {
            let id = company(slot).id;
            let worker = &world.workers[w];
            world.sign(worker, "accept_invite", (id, worker).into_val(e));
            flatten(c.try_accept_invite(&id, worker))
        }
        Op::Remove(slot, w) => {
            let id = company(slot).id;
            world.sign(admin(slot), "remove_worker", (id, &world.workers[w]).into_val(e));
            flatten(c.try_remove_worker(&id, &world.workers[w]))
        }
        Op::Open(slot, r, expected) => {
            let id = company(slot).id;
            let period = world.period();
            world.sign(
                admin(slot),
                "open_run",
                (id, RUN_IDS[r], &period, expected).into_val(e),
            );
            flatten(c.try_open_run(&id, &RUN_IDS[r], &period, &expected))
        }
        Op::Pay(slot, r, ref workers) => {
            let id = company(slot).id;
            let items = world.items(slot, r, workers, step);
            world.sign_pay(admin(slot), id, RUN_IDS[r], &items);
            flatten(c.try_pay(&id, &RUN_IDS[r], &items))
        }
        Op::Close(slot, r) => {
            let id = company(slot).id;
            world.sign(admin(slot), "close_run", (id, RUN_IDS[r]).into_val(e));
            flatten(c.try_close_run(&id, &RUN_IDS[r]))
        }
        Op::ProposeAdmin(slot, candidate, window) => {
            let id = company(slot).id;
            let new_admin = &world.candidates[slot][candidate];
            let live_until = seq + window;
            world.sign(
                admin(slot),
                "propose_admin",
                (id, new_admin, live_until).into_val(e),
            );
            flatten(c.try_propose_admin(&id, new_admin, &live_until))
        }
        Op::CancelAdmin(slot) => {
            let id = company(slot).id;
            world.sign(admin(slot), "cancel_admin_proposal", (id,).into_val(e));
            flatten(c.try_cancel_admin_proposal(&id))
        }
        Op::AcceptAdmin(slot) => {
            let id = company(slot).id;
            let candidate = company(slot).pending.map_or(1, |(candidate, _)| candidate);
            world.sign(
                &world.candidates[slot][candidate],
                "accept_admin",
                (id,).into_val(e),
            );
            flatten(c.try_accept_admin(&id))
        }
        Op::Advance(ledgers) => {
            e.ledger().set_sequence_number(seq + ledgers);
            Ok(())
        }
        Op::Foreign(slot, r, kind) => {
            let id = company(slot).id;
            let other = 1 - slot;
            let attacker = match &model.companies[other] {
                Some(company) => &world.candidates[other][company.admin],
                None => &world.candidates[other][0],
            };
            let run_id = RUN_IDS[r];
            let worker = &world.workers[0];
            match kind {
                0 => {
                    let items = world.items(slot, r, &[0], step);
                    world.sign_pay(attacker, id, run_id, &items);
                    flatten(c.try_pay(&id, &run_id, &items))
                }
                1 => {
                    world.sign(attacker, "close_run", (id, run_id).into_val(e));
                    flatten(c.try_close_run(&id, &run_id))
                }
                2 => {
                    let period = world.period();
                    world.sign(attacker, "open_run", (id, run_id, &period, 1u32).into_val(e));
                    flatten(c.try_open_run(&id, &run_id, &period, &1))
                }
                3 => {
                    world.sign(attacker, "invite_worker", (id, worker).into_val(e));
                    flatten(c.try_invite_worker(&id, worker))
                }
                4 => {
                    world.sign(attacker, "remove_worker", (id, worker).into_val(e));
                    flatten(c.try_remove_worker(&id, worker))
                }
                _ => {
                    world.sign(attacker, "revoke_invite", (id, worker).into_val(e));
                    flatten(c.try_revoke_invite(&id, worker))
                }
            }
        }
    }
}

/// Everything observed so far, independent of the model.
#[derive(Default)]
struct Observed {
    transfers_seen: u32,
    transferred: [[[u32; WORKERS]; RUNS]; SLOTS],
    payslips: [[[u32; WORKERS]; RUNS]; SLOTS],
    snapshots: [Option<Snapshot>; SLOTS],
}

fn step(world: &World, model: &mut Model, seen: &mut Observed, op: &Op, step_index: usize) {
    let target = op.target();
    if let Some(slot) = target {
        let created = model.companies[slot].is_some();
        if created == matches!(op, Op::Create(_)) {
            return;
        }
    }

    let seq = world.seq();
    let mut next = model.clone();
    let expected = match *op {
        Op::Create(slot) => {
            next.companies[slot] = Some(CompanyModel {
                id: next.next_id,
                admin: 0,
                pending: None,
                status: [None; WORKERS],
                roster: vec![],
                active: 0,
                runs: [None, None],
                created_ledger: seq,
            });
            next.next_id += 1;
            Ok(vec![])
        }
        Op::Advance(_) => Ok(vec![]),
        _ => predict(next.companies[target.unwrap()].as_mut().unwrap(), op, seq),
    };

    let actual = call(world, model, op, step_index);
    let events: Vec<ContractEvent> = match op {
        Op::Advance(_) => vec![],
        _ => world
            .e
            .events()
            .all()
            .filter_by_contract(&world.payroll)
            .events()
            .to_vec(),
    };
    if let Op::Foreign(..) = op {
        assert!(world.call_failed_on_auth(), "foreign call did not fail on a signature");
    }

    assert_eq!(
        actual,
        expected.clone().map(|_| ()),
        "result of {op:?} at step {step_index}"
    );
    let paid_now = expected.unwrap_or_default();

    // C8: count payslip events per (company, run, worker) from what the
    // contract actually emitted, not from the model.
    let mut payslips_now = 0;
    for (slot, company) in next.companies.iter().enumerate() {
        let Some(company) = company else { continue };
        for (r, run_id) in RUN_IDS.iter().enumerate() {
            for w in 0..WORKERS {
                let payslip = PayslipIssued {
                    company_id: company.id,
                    run_id: *run_id,
                    worker: world.workers[w].clone(),
                }
                .to_xdr(&world.e, &world.payroll);
                let count = events.iter().filter(|event| **event == payslip).count() as u32;
                seen.payslips[slot][r][w] += count;
                payslips_now += count;
            }
        }
    }
    match *op {
        Op::Pay(slot, r, _) if !paid_now.is_empty() => {
            let id = next.companies[slot].as_ref().unwrap().id;
            let expected_events: Vec<ContractEvent> = paid_now
                .iter()
                .map(|&w| {
                    PayslipIssued {
                        company_id: id,
                        run_id: RUN_IDS[r],
                        worker: world.workers[w].clone(),
                    }
                    .to_xdr(&world.e, &world.payroll)
                })
                .collect();
            assert_eq!(events, expected_events);
        }
        _ => assert_eq!(payslips_now, 0, "payslip from {op:?}"),
    }

    // C5 and C7: every new transfer, read back from the mock token.
    let transfers = MockTokenClient::new(&world.e, &world.token).transfers();
    let new_transfers: Vec<_> = (seen.transfers_seen..transfers.len())
        .map(|i| transfers.get(i).unwrap())
        .collect();
    seen.transfers_seen = transfers.len();
    match *op {
        Op::Pay(slot, r, ref workers) if !paid_now.is_empty() => {
            let before = model.companies[slot].as_ref().unwrap();
            let treasury = &world.candidates[slot][before.admin];
            let items = world.items(slot, r, workers, step_index);
            assert_eq!(new_transfers.len() as u32, items.len());
            for (transfer, (worker, data)) in new_transfers.iter().zip(items.iter()) {
                assert_eq!(&transfer.from, treasury, "C5: money left the current admin");
                assert_ne!(transfer.to, transfer.from, "C5: the treasury paid itself");
                assert_eq!(transfer.to, worker);
                assert_eq!(transfer.data, data);
                let w = world.workers.iter().position(|a| *a == transfer.to).unwrap();
                assert_eq!(
                    before.status[w],
                    Some(WorkerStatus::Active),
                    "C5: paid a worker who was not active"
                );
                seen.transferred[slot][r][w] += 1;
                assert!(seen.transferred[slot][r][w] <= 1, "C7: paid twice");
            }
        }
        _ => assert!(new_transfers.is_empty(), "transfer from {op:?}"),
    }

    if actual.is_ok() {
        *model = next;
    }

    for slot in 0..SLOTS {
        let Some(company) = &model.companies[slot] else { continue };
        let snapshot = world.snapshot(company.id);

        // C6: a step aimed at one company never changes the other.
        if target != Some(slot) {
            if let Some(previous) = &seen.snapshots[slot] {
                assert_eq!(&snapshot, previous, "C6: {op:?} changed company {slot}");
            }
        }
        assert_eq!(snapshot, world.expected_snapshot(slot, company));

        // C8: paid_count equals the payslips seen and the transfers made for
        // that run, and never exceeds expected_count.
        for r in 0..RUNS {
            let payslips: u32 = seen.payslips[slot][r].iter().sum();
            let transfers: u32 = seen.transferred[slot][r].iter().sum();
            assert!(seen.payslips[slot][r].iter().all(|&n| n <= 1), "C7: two payslips");
            match &snapshot.runs[r] {
                Some(run) => {
                    assert_eq!(run.paid_count, payslips, "C8: paid_count against payslips");
                    assert_eq!(payslips, transfers, "C8: payslip without a transfer");
                    assert!(run.paid_count <= run.expected_count, "C8: over expected_count");
                }
                None => assert_eq!(payslips, 0),
            }
        }
        seen.snapshots[slot] = Some(snapshot);
    }
}

proptest! {
    #![proptest_config(ProptestConfig {
        cases: 128,
        failure_persistence: None,
        ..ProptestConfig::default()
    })]

    #[test]
    fn random_payroll_sequences_keep_every_invariant(ops in sequence()) {
        let world = World::new();
        let mut model = Model::default();
        let mut seen = Observed::default();
        for (step_index, op) in ops.iter().enumerate() {
            step(&world, &mut model, &mut seen, op, step_index);
        }
    }
}

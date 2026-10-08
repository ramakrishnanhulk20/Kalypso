//! pay: what it moves, under whose signature, every way it refuses, and that
//! its records outlast temporary storage. Also the storage lifetimes every
//! state-changing call keeps, which share this file's setup helpers.
//!
//! Not covered here: real proofs and the real token (a real transfer can also
//! fail on a stale or forged proof; M2c covers that against the real token
//! wasm), transaction size and CPU limits (MAX_BATCH comes from testnet
//! measurements in scratchpad/m1a/FINDINGS.md), and wrong-signer cases other
//! than the nested transfer, which are in auth.rs.
extern crate std;

use soroban_sdk::{
    testutils::{AuthorizedFunction, AuthorizedInvocation, MockAuth, MockAuthInvoke},
    Address, Bytes, Error, Event as _, IntoVal, Symbol, Vec,
};

use super::{err, Setup, Team, COMPANY_AUDITOR, OTHER_AUDITOR, WORKER_AUDITOR};
use crate::{
    PayrollError, PayslipIssued, WorkerStatus, DAY_IN_LEDGERS, INSTANCE_EXTEND_THRESHOLD,
    INSTANCE_EXTEND_TO, MAX_BATCH, RECORD_EXTEND_THRESHOLD, RECORD_EXTEND_TO,
};

/// Signs `items` as `treasury`, expects `pay` to fail with `expected`, and
/// checks the failed call left no event and no transfer behind.
fn assert_pay_fails(
    s: &Setup,
    treasury: &Address,
    company_id: u64,
    run_id: u64,
    items: &Vec<(Address, Bytes)>,
    expected: Error,
) {
    let transfers_before = s.transfers().len();
    s.sign_pay(treasury, treasury, company_id, run_id, items);

    let result = s.client().try_pay(&company_id, &run_id, items);

    assert_eq!(result, Err(Ok(expected)));
    assert!(s.payroll_events().events().is_empty());
    assert_eq!(s.transfers().len(), transfers_before);
}

fn payslips(
    s: &Setup,
    company_id: u64,
    run_id: u64,
    workers: &[&Address],
) -> std::vec::Vec<soroban_sdk::xdr::ContractEvent> {
    workers
        .iter()
        .map(|worker| {
            PayslipIssued {
                company_id,
                run_id,
                worker: (*worker).clone(),
            }
            .to_xdr(&s.e, &s.payroll)
        })
        .collect()
}

#[test]
fn pay_transfers_from_the_admin_to_each_worker_and_emits_payslips() {
    let s = Setup::new();
    let t = s.team(2);
    s.open_run(t.company_id, &t.admin, 7, 2);
    let items = s.items(&[&t.workers[0], &t.workers[1]]);

    s.pay(t.company_id, 7, &t.admin, &items);

    assert_eq!(
        s.payroll_events(),
        payslips(&s, t.company_id, 7, &[&t.workers[0], &t.workers[1]])
    );
    let transfers = s.transfers();
    assert_eq!(transfers.len(), 2);
    for (i, (worker, data)) in items.iter().enumerate() {
        let transfer = transfers.get(i as u32).unwrap();
        assert_eq!(transfer.from, t.admin);
        assert_eq!(transfer.to, worker);
        assert_eq!(transfer.data, data);
        assert!(s.client().is_paid(&t.company_id, &7, &worker));
    }
    assert_eq!(s.client().get_run(&t.company_id, &7).paid_count, 2);
}

/// C5: one signature from the admin, rooted at pay, covers exactly the nested
/// transfers from the admin to each listed worker.
#[test]
fn pay_is_authorized_by_one_admin_tree_rooted_at_pay() {
    let s = Setup::new();
    let t = s.team(2);
    s.open_run(t.company_id, &t.admin, 7, 2);
    let items = s.items(&[&t.workers[0], &t.workers[1]]);

    s.pay(t.company_id, 7, &t.admin, &items);

    let nested: std::vec::Vec<AuthorizedInvocation> = items
        .iter()
        .map(|(worker, data)| AuthorizedInvocation {
            function: AuthorizedFunction::Contract((
                s.token.clone(),
                Symbol::new(&s.e, "confidential_transfer"),
                (&t.admin, worker, data).into_val(&s.e),
            )),
            sub_invocations: std::vec![],
        })
        .collect();
    assert_eq!(
        s.e.auths(),
        std::vec![(
            t.admin.clone(),
            AuthorizedInvocation {
                function: AuthorizedFunction::Contract((
                    s.payroll.clone(),
                    Symbol::new(&s.e, "pay"),
                    (t.company_id, 7u64, items.clone()).into_val(&s.e),
                )),
                sub_invocations: nested,
            }
        )]
    );
}

/// C5: signing the pay call alone is not enough. The token demands the
/// admin's signature over each exact transfer, so a tree without the nested
/// transfer fails and nothing moves.
#[test]
fn pay_fails_when_the_admin_did_not_sign_the_nested_transfer() {
    let s = Setup::new();
    let t = s.team(1);
    s.open_run(t.company_id, &t.admin, 7, 1);
    let items = s.items(&[&t.workers[0]]);

    s.sign(
        &t.admin,
        "pay",
        (t.company_id, 7u64, items.clone()).into_val(&s.e),
    );
    let result = s.client().try_pay(&t.company_id, &7, &items);

    s.assert_auth_failed(result);
    assert!(s.transfers().is_empty());
    assert!(!s.client().is_paid(&t.company_id, &7, &t.workers[0]));
    assert_eq!(s.client().get_run(&t.company_id, &7).paid_count, 0);
}

/// A failure in the second nested transfer undoes the first transfer, its
/// paid flag and its event: the admin signed only the first transfer.
#[test]
fn a_failed_transfer_mid_batch_undoes_the_whole_call() {
    let s = Setup::new();
    let t = s.team(2);
    s.open_run(t.company_id, &t.admin, 7, 2);
    let items = s.items(&[&t.workers[0], &t.workers[1]]);
    let (first_worker, first_data) = items.get(0).unwrap();
    let only_first = [MockAuthInvoke {
        contract: &s.token,
        fn_name: "confidential_transfer",
        args: (&t.admin, &first_worker, &first_data).into_val(&s.e),
        sub_invokes: &[],
    }];
    s.e.mock_auths(&[MockAuth {
        address: &t.admin,
        invoke: &MockAuthInvoke {
            contract: &s.payroll,
            fn_name: "pay",
            args: (t.company_id, 7u64, items.clone()).into_val(&s.e),
            sub_invokes: &only_first,
        },
    }]);

    let result = s.client().try_pay(&t.company_id, &7, &items);

    s.assert_auth_failed(result);
    assert!(s.payroll_events().events().is_empty());
    assert!(s.transfers().is_empty());
    assert!(!s.client().is_paid(&t.company_id, &7, &t.workers[0]));
    assert!(!s.client().is_paid(&t.company_id, &7, &t.workers[1]));
    assert_eq!(s.client().get_run(&t.company_id, &7).paid_count, 0);
}

#[test]
fn pay_rejects_an_unknown_company() {
    let s = Setup::new();
    let t = s.team(1);
    let items = s.items(&[&t.workers[0]]);

    assert_pay_fails(&s, &t.admin, 42, 7, &items, err(PayrollError::CompanyNotFound));
}

#[test]
fn pay_rejects_an_unknown_run() {
    let s = Setup::new();
    let t = s.team(1);
    let items = s.items(&[&t.workers[0]]);

    assert_pay_fails(&s, &t.admin, t.company_id, 7, &items, err(PayrollError::RunNotFound));
}

#[test]
fn pay_rejects_a_closed_run() {
    let s = Setup::new();
    let t = s.team(1);
    s.open_run(t.company_id, &t.admin, 7, 1);
    s.close_run(t.company_id, &t.admin, 7);
    let items = s.items(&[&t.workers[0]]);

    assert_pay_fails(&s, &t.admin, t.company_id, 7, &items, err(PayrollError::RunNotOpen));
    assert!(!s.client().is_paid(&t.company_id, &7, &t.workers[0]));
}

#[test]
fn pay_rejects_an_empty_batch() {
    let s = Setup::new();
    let t = s.team(1);
    s.open_run(t.company_id, &t.admin, 7, 1);

    assert_pay_fails(&s, &t.admin, t.company_id, 7, &s.items(&[]), err(PayrollError::NoItems));
}

#[test]
fn pay_rejects_a_batch_above_max_batch() {
    let s = Setup::new();
    let t = s.team(3);
    s.open_run(t.company_id, &t.admin, 7, 3);
    let items = s.items(&[&t.workers[0], &t.workers[1], &t.workers[2]]);
    assert_eq!(items.len(), MAX_BATCH + 1);

    assert_pay_fails(&s, &t.admin, t.company_id, 7, &items, err(PayrollError::TooManyItems));
    for worker in &t.workers {
        assert!(!s.client().is_paid(&t.company_id, &7, worker));
    }
}

/// C5 and C8: a worker who was never invited, has not accepted, was removed,
/// or is active only in another company cannot be paid by this company, and
/// a valid first item in the same batch is not paid either.
#[test]
fn pay_rejects_workers_who_are_not_active_here_right_now() {
    let s = Setup::new();
    let t = s.team(2);
    let stranger = s.account(WORKER_AUDITOR);
    let invited = s.account(WORKER_AUDITOR);
    s.invite(t.company_id, &t.admin, &invited);
    let removed = t.workers[1].clone();
    s.remove(t.company_id, &t.admin, &removed);
    let other_admin = s.account(OTHER_AUDITOR);
    let other = s.create_company(&other_admin, OTHER_AUDITOR, "Beta");
    let elsewhere = s.account(WORKER_AUDITOR);
    s.join(other, &other_admin, &elsewhere);
    s.open_run(t.company_id, &t.admin, 7, 1);

    for outsider in [&stranger, &invited, &removed, &elsewhere] {
        let items = s.items(&[&t.workers[0], outsider]);
        assert_pay_fails(&s, &t.admin, t.company_id, 7, &items, err(PayrollError::NotActive));
        assert!(!s.client().is_paid(&t.company_id, &7, &t.workers[0]));
    }
}

/// C5: the treasury is never paid from itself. Listing the admin is refused
/// even though the admin is not a worker, which is the reachable case. It is
/// also refused when the admin is forced into storage as an active worker, a
/// state accept_admin and accept_invite never produce, and a valid first item
/// in the same batch is not paid either.
#[test]
fn pay_refuses_an_item_that_names_the_current_admin() {
    let s = Setup::new();
    let t = s.team(1);
    s.open_run(t.company_id, &t.admin, 7, 1);
    let to_admin = s.items(&[&t.admin]);

    assert_pay_fails(&s, &t.admin, t.company_id, 7, &to_admin, err(PayrollError::WorkerIsAdmin));

    s.force_worker_status(t.company_id, &t.admin, WorkerStatus::Active);
    assert_pay_fails(&s, &t.admin, t.company_id, 7, &to_admin, err(PayrollError::WorkerIsAdmin));
    let mixed = s.items(&[&t.workers[0], &t.admin]);
    assert_pay_fails(&s, &t.admin, t.company_id, 7, &mixed, err(PayrollError::WorkerIsAdmin));
    assert!(!s.client().is_paid(&t.company_id, &7, &t.workers[0]));
    assert!(!s.client().is_paid(&t.company_id, &7, &t.admin));
    assert_eq!(s.client().get_run(&t.company_id, &7).paid_count, 0);
}

/// C7: the same worker twice in one batch reverts the whole call, so even
/// the first listing is not paid.
#[test]
fn pay_rejects_the_same_worker_twice_in_one_batch_and_pays_nobody() {
    let s = Setup::new();
    let t = s.team(2);
    s.open_run(t.company_id, &t.admin, 7, 2);
    let mut items = s.items(&[&t.workers[0]]);
    items.push_back((t.workers[0].clone(), Bytes::from_array(&s.e, &[0xB0; 48])));

    assert_pay_fails(&s, &t.admin, t.company_id, 7, &items, err(PayrollError::AlreadyPaid));
    assert!(!s.client().is_paid(&t.company_id, &7, &t.workers[0]));
    assert_eq!(s.client().get_run(&t.company_id, &7).paid_count, 0);
}

/// C7: a second pay for the same worker in the same run is refused, whether
/// it repeats the first batch or pairs the worker with someone new.
#[test]
fn pay_rejects_a_worker_already_paid_in_this_run() {
    let s = Setup::new();
    let t = s.team(2);
    s.open_run(t.company_id, &t.admin, 7, 2);
    let first = s.items(&[&t.workers[0]]);
    s.pay(t.company_id, 7, &t.admin, &first);

    assert_pay_fails(&s, &t.admin, t.company_id, 7, &first, err(PayrollError::AlreadyPaid));
    let paired = s.items(&[&t.workers[1], &t.workers[0]]);
    assert_pay_fails(&s, &t.admin, t.company_id, 7, &paired, err(PayrollError::AlreadyPaid));
    assert!(!s.client().is_paid(&t.company_id, &7, &t.workers[1]));
    assert_eq!(s.client().get_run(&t.company_id, &7).paid_count, 1);
}

#[test]
fn pay_rejects_payments_beyond_the_expected_count() {
    let s = Setup::new();
    let t = s.team(2);
    s.open_run(t.company_id, &t.admin, 7, 1);
    let items = s.items(&[&t.workers[0], &t.workers[1]]);

    assert_pay_fails(
        &s,
        &t.admin,
        t.company_id,
        7,
        &items,
        err(PayrollError::ExpectedCountExceeded),
    );
    s.pay(t.company_id, 7, &t.admin, &s.items(&[&t.workers[1]]));
    assert_pay_fails(
        &s,
        &t.admin,
        t.company_id,
        7,
        &s.items(&[&t.workers[0]]),
        err(PayrollError::ExpectedCountExceeded),
    );
    assert_eq!(s.client().get_run(&t.company_id, &7).paid_count, 1);
}

/// The run's paid count is forced to the u32 limit. pay is refused with
/// CounterOverflow, which is checked before the expected count, and nothing
/// is paid.
#[test]
fn pay_refuses_when_the_runs_paid_count_is_at_its_limit() {
    let s = Setup::new();
    let t = s.team(1);
    s.open_run(t.company_id, &t.admin, 7, 1);
    s.force_run(t.company_id, 7, |run| run.paid_count = u32::MAX);
    let items = s.items(&[&t.workers[0]]);

    assert_pay_fails(&s, &t.admin, t.company_id, 7, &items, err(PayrollError::CounterOverflow));
    assert!(!s.client().is_paid(&t.company_id, &7, &t.workers[0]));
    assert_eq!(s.client().get_run(&t.company_id, &7).paid_count, u32::MAX);
}

#[test]
fn a_worker_paid_in_one_run_is_paid_again_in_the_next() {
    let s = Setup::new();
    let t = s.team(1);
    let items = s.items(&[&t.workers[0]]);
    s.open_run(t.company_id, &t.admin, 7, 1);
    s.pay(t.company_id, 7, &t.admin, &items);
    s.close_run(t.company_id, &t.admin, 7);

    s.open_run(t.company_id, &t.admin, 8, 1);
    s.pay(t.company_id, 8, &t.admin, &items);

    assert_eq!(s.payroll_events(), payslips(&s, t.company_id, 8, &[&t.workers[0]]));
    assert_eq!(s.transfers().len(), 2);
}

/// C8: the paid flag is persistent. A day and one ledger later, past
/// mainnet's 17,280-ledger temporary lifetime and far past testnet's 720, a
/// repeat pay is still refused as AlreadyPaid.
#[test]
fn the_paid_flag_outlives_the_temporary_storage_lifetime() {
    let s = Setup::new();
    let t = s.team(1);
    s.open_run(t.company_id, &t.admin, 7, 1);
    let items = s.items(&[&t.workers[0]]);
    s.pay(t.company_id, 7, &t.admin, &items);

    s.advance(DAY_IN_LEDGERS + 1);

    assert!(s.client().is_paid(&t.company_id, &7, &t.workers[0]));
    assert_pay_fails(&s, &t.admin, t.company_id, 7, &items, err(PayrollError::AlreadyPaid));
    assert_eq!(s.transfers().len(), 1);
}

/// C8: every record is persistent and extended to RECORD_EXTEND_TO when
/// written, the instance to INSTANCE_EXTEND_TO, and the contract keeps
/// nothing in temporary storage.
#[test]
fn every_record_is_persistent_and_extended_when_written() {
    let s = Setup::new();
    let t = s.team(1);
    s.open_run(t.company_id, &t.admin, 7, 1);
    s.pay(t.company_id, 7, &t.admin, &s.items(&[&t.workers[0]]));
    let successor = s.account(COMPANY_AUDITOR);
    s.propose_admin(t.company_id, &t.admin, &successor, s.seq() + 100);
    let id = t.company_id;
    let worker = &t.workers[0];

    for key in [
        s.key("Company", (id,)),
        s.key("Worker", (id, worker)),
        s.key("RosterAt", (id, 0u32)),
        s.key("Run", (id, 7u64)),
        s.key("Paid", (id, 7u64, worker)),
        s.key("PendingAdmin", (id,)),
    ] {
        assert_eq!(s.record_ttl(key), RECORD_EXTEND_TO);
    }
    assert_eq!(s.instance_ttl(), INSTANCE_EXTEND_TO);
    assert_eq!(s.temporary_entry_count(), 0);
}

/// C8: pay extends the company and worker records it reads but does not
/// write. Tests, like the network since protocol 23, restore archived entries
/// automatically, so a plain read cannot show that an entry expired; its
/// exact TTL can. One ledger past the records' original lifetime they still
/// have a full day left. The roster entry, which pay does not read, is the
/// control: pay leaves its lifetime alone.
#[test]
fn pay_keeps_the_records_it_reads_alive_past_their_original_lifetime() {
    let s = Setup::new();
    let t = s.team(1);
    s.open_run(t.company_id, &t.admin, 7, 1);
    let worker = &t.workers[0];
    let company = s.key("Company", (t.company_id,));
    let record = s.key("Worker", (t.company_id, worker));
    let roster = s.key("RosterAt", (t.company_id, 0u32));
    for key in [company, record, roster] {
        assert_eq!(s.record_ttl(key), RECORD_EXTEND_TO);
    }

    s.advance(DAY_IN_LEDGERS + 1);
    s.pay(t.company_id, 7, &t.admin, &s.items(&[worker]));

    assert_eq!(s.record_ttl(company), RECORD_EXTEND_TO);
    assert_eq!(s.record_ttl(record), RECORD_EXTEND_TO);
    assert_eq!(s.record_ttl(roster), RECORD_EXTEND_TO - DAY_IN_LEDGERS - 1);

    s.advance(RECORD_EXTEND_TO - DAY_IN_LEDGERS);
    assert_eq!(s.record_ttl(company), DAY_IN_LEDGERS);
    assert_eq!(s.record_ttl(record), DAY_IN_LEDGERS);
}

type Change = (&'static str, fn(&Setup) -> Team, fn(&Setup, &Team));

fn with_open_run(s: &Setup) -> Team {
    let t = s.team(1);
    s.open_run(t.company_id, &t.admin, 7, 1);
    t
}

/// `workers[0]` is the proposed admin.
fn with_proposal(s: &Setup) -> Team {
    let t = s.team(0);
    let successor = s.account(COMPANY_AUDITOR);
    s.propose_admin(t.company_id, &t.admin, &successor, s.seq() + 2 * DAY_IN_LEDGERS);
    Team {
        company_id: t.company_id,
        admin: t.admin,
        workers: std::vec![successor],
    }
}

/// `workers[0]` holds a pending invite.
fn with_invite(s: &Setup) -> Team {
    let t = s.team(0);
    let worker = s.account(WORKER_AUDITOR);
    s.invite(t.company_id, &t.admin, &worker);
    Team {
        company_id: t.company_id,
        admin: t.admin,
        workers: std::vec![worker],
    }
}

/// Every state-changing call on an existing company, with the setup it needs.
fn changes_to_one_company() -> [Change; 10] {
    [
        ("propose_admin", |s| s.team(0), |s, t| {
            s.propose_admin(t.company_id, &t.admin, &t.admin, s.seq() + 10)
        }),
        ("cancel_admin_proposal", with_proposal, |s, t| {
            s.sign(&t.admin, "cancel_admin_proposal", (t.company_id,).into_val(&s.e));
            s.client().cancel_admin_proposal(&t.company_id);
        }),
        ("accept_admin", with_proposal, |s, t| {
            s.accept_admin(t.company_id, &t.workers[0])
        }),
        ("invite_worker", |s| s.team(0), |s, t| {
            s.invite(t.company_id, &t.admin, &s.account(WORKER_AUDITOR))
        }),
        ("revoke_invite", with_invite, |s, t| {
            s.revoke(t.company_id, &t.admin, &t.workers[0])
        }),
        ("accept_invite", with_invite, |s, t| s.accept(t.company_id, &t.workers[0])),
        ("remove_worker", |s| s.team(1), |s, t| {
            s.remove(t.company_id, &t.admin, &t.workers[0])
        }),
        ("open_run", |s| s.team(1), |s, t| s.open_run(t.company_id, &t.admin, 7, 1)),
        ("pay", with_open_run, |s, t| {
            s.pay(t.company_id, 7, &t.admin, &s.items(&[&t.workers[0]]))
        }),
        ("close_run", with_open_run, |s, t| s.close_run(t.company_id, &t.admin, 7)),
    ]
}

/// Every state-changing call extends the instance lifetime once it has
/// dropped below the threshold.
#[test]
fn every_state_changing_call_extends_the_instance() {
    fn check(name: &str, prepare: fn(&Setup) -> Team, act: fn(&Setup, &Team)) {
        let s = Setup::new();
        let t = prepare(&s);
        s.advance(DAY_IN_LEDGERS + 1);
        assert!(s.instance_ttl() < INSTANCE_EXTEND_THRESHOLD, "{name}");
        act(&s, &t);
        assert_eq!(s.instance_ttl(), INSTANCE_EXTEND_TO, "{name}");
    }

    check("create_company", |s| s.team(0), |s, _| {
        s.create_company(&s.account(OTHER_AUDITOR), OTHER_AUDITOR, "Beta");
    });
    for (name, prepare, act) in changes_to_one_company() {
        check(name, prepare, act);
    }
}

/// Every state-changing call on a company extends its record, whether the
/// call writes the record or only reads it.
#[test]
fn every_state_changing_call_extends_the_company_record() {
    for (name, prepare, act) in changes_to_one_company() {
        let s = Setup::new();
        let t = prepare(&s);
        let company = s.key("Company", (t.company_id,));
        s.advance(DAY_IN_LEDGERS + 1);
        assert!(s.record_ttl(company) < RECORD_EXTEND_THRESHOLD, "{name}");

        act(&s, &t);

        assert_eq!(s.record_ttl(company), RECORD_EXTEND_TO, "{name}");
    }
}

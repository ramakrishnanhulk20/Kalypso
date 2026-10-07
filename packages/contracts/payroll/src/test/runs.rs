//! open_run, close_run and get_run, including two companies using the same
//! run id.
//!
//! Not covered here: paying into a run (pay.rs) and wrong-signer cases
//! (auth.rs).
extern crate std;

use soroban_sdk::{Event as _, IntoVal, String};

use super::{err, Setup, OTHER_AUDITOR, WORKER_AUDITOR};
use crate::{PayrollError, Run, RunClosed, RunOpened, RunStatus};

#[test]
fn open_run_stores_an_open_run_and_emits_run_opened() {
    let s = Setup::new();
    let t = s.team(3);
    let label = s.text("October 2026");

    s.open_run(t.company_id, &t.admin, 7, 3);

    assert_eq!(
        s.payroll_events(),
        std::vec![RunOpened {
            company_id: t.company_id,
            run_id: 7,
            period_label: label.clone(),
            expected_count: 3,
        }
        .to_xdr(&s.e, &s.payroll)]
    );
    assert_eq!(
        s.client().get_run(&t.company_id, &7),
        Run {
            status: RunStatus::Open,
            period_label: label,
            expected_count: 3,
            paid_count: 0,
            opened_ledger: 1_000,
        }
    );
}

/// C7: a run id opens once per company, ever, whether the first run is still
/// open or already closed.
#[test]
fn open_run_rejects_a_run_id_already_used_open_or_closed() {
    let s = Setup::new();
    let t = s.team(1);
    let label = s.text("October 2026");
    s.open_run(t.company_id, &t.admin, 7, 1);
    s.open_run(t.company_id, &t.admin, 8, 1);
    s.close_run(t.company_id, &t.admin, 8);

    for run_id in [7u64, 8] {
        s.sign(
            &t.admin,
            "open_run",
            (t.company_id, run_id, &label, 1u32).into_val(&s.e),
        );
        assert_eq!(
            s.client().try_open_run(&t.company_id, &run_id, &label, &1),
            Err(Ok(err(PayrollError::RunExists)))
        );
    }
    assert_eq!(
        s.client().get_run(&t.company_id, &8).status,
        RunStatus::Closed
    );
}

#[test]
fn open_run_rejects_empty_and_oversized_period_labels() {
    let s = Setup::new();
    let t = s.team(1);
    let empty = s.text("");
    let too_long = String::from_bytes(&s.e, &[b'x'; 33]);
    let longest = String::from_bytes(&s.e, &[b'x'; 32]);

    for label in [&empty, &too_long] {
        s.sign(
            &t.admin,
            "open_run",
            (t.company_id, 7u64, label, 1u32).into_val(&s.e),
        );
        assert_eq!(
            s.client().try_open_run(&t.company_id, &7, label, &1),
            Err(Ok(err(PayrollError::LabelInvalid)))
        );
    }

    s.sign(
        &t.admin,
        "open_run",
        (t.company_id, 7u64, &longest, 1u32).into_val(&s.e),
    );
    s.client().open_run(&t.company_id, &7, &longest, &1);
    assert_eq!(s.client().get_run(&t.company_id, &7).period_label, longest);
}

#[test]
fn open_run_rejects_an_expected_count_of_zero_or_above_the_active_workers() {
    let s = Setup::new();
    let t = s.team(2);
    let label = s.text("October 2026");
    let empty_team = s.create_company(&s.account(OTHER_AUDITOR), OTHER_AUDITOR, "Empty");
    let empty_admin = s.client().get_company(&empty_team).admin;

    for (company_id, admin, expected_count) in [
        (t.company_id, &t.admin, 0u32),
        (t.company_id, &t.admin, 3),
        (empty_team, &empty_admin, 1),
    ] {
        s.sign(
            admin,
            "open_run",
            (company_id, 7u64, &label, expected_count).into_val(&s.e),
        );
        assert_eq!(
            s.client()
                .try_open_run(&company_id, &7, &label, &expected_count),
            Err(Ok(err(PayrollError::ExpectedCountInvalid)))
        );
    }

    s.open_run(t.company_id, &t.admin, 7, 2);
}

#[test]
fn run_functions_fail_for_an_unknown_company() {
    let s = Setup::new();
    let someone = s.account(OTHER_AUDITOR);
    let label = s.text("October 2026");

    s.sign(
        &someone,
        "open_run",
        (6u64, 7u64, &label, 1u32).into_val(&s.e),
    );
    assert_eq!(
        s.client().try_open_run(&6, &7, &label, &1),
        Err(Ok(err(PayrollError::CompanyNotFound)))
    );
    s.sign(&someone, "close_run", (6u64, 7u64).into_val(&s.e));
    assert_eq!(
        s.client().try_close_run(&6, &7),
        Err(Ok(err(PayrollError::CompanyNotFound)))
    );
}

#[test]
fn close_run_closes_and_emits_run_closed_with_the_paid_count() {
    let s = Setup::new();
    let t = s.team(2);
    s.open_run(t.company_id, &t.admin, 7, 2);
    s.pay(t.company_id, 7, &t.admin, &s.items(&[&t.workers[0]]));

    s.close_run(t.company_id, &t.admin, 7);

    assert_eq!(
        s.payroll_events(),
        std::vec![RunClosed {
            company_id: t.company_id,
            run_id: 7,
            paid_count: 1,
        }
        .to_xdr(&s.e, &s.payroll)]
    );
    let run = s.client().get_run(&t.company_id, &7);
    assert_eq!(run.status, RunStatus::Closed);
    assert_eq!(run.paid_count, 1);
}

#[test]
fn close_run_rejects_an_unknown_or_closed_run() {
    let s = Setup::new();
    let t = s.team(1);
    s.open_run(t.company_id, &t.admin, 7, 1);
    s.close_run(t.company_id, &t.admin, 7);

    s.sign(&t.admin, "close_run", (t.company_id, 9u64).into_val(&s.e));
    assert_eq!(
        s.client().try_close_run(&t.company_id, &9),
        Err(Ok(err(PayrollError::RunNotFound)))
    );
    s.sign(&t.admin, "close_run", (t.company_id, 7u64).into_val(&s.e));
    assert_eq!(
        s.client().try_close_run(&t.company_id, &7),
        Err(Ok(err(PayrollError::RunNotOpen)))
    );
}

#[test]
fn get_run_fails_for_a_run_the_company_never_opened() {
    let s = Setup::new();
    let t = s.team(1);

    assert_eq!(
        s.client().try_get_run(&t.company_id, &7),
        Err(Ok(err(PayrollError::RunNotFound)))
    );
}

/// C6: company B opens, pays and closes its own run 7, and company A's run 7
/// and paid flags do not change.
#[test]
fn another_company_using_the_same_run_id_leaves_the_first_untouched() {
    let s = Setup::new();
    let a = s.team(2);
    let b_admin = s.account(OTHER_AUDITOR);
    let b = s.create_company(&b_admin, OTHER_AUDITOR, "Beta");
    let b_worker = s.account(WORKER_AUDITOR);
    s.join(b, &b_admin, &b_worker);
    s.open_run(a.company_id, &a.admin, 7, 2);
    s.pay(a.company_id, 7, &a.admin, &s.items(&[&a.workers[0]]));
    let a_run = s.client().get_run(&a.company_id, &7);

    s.open_run(b, &b_admin, 7, 1);
    s.pay(b, 7, &b_admin, &s.items(&[&b_worker]));
    s.close_run(b, &b_admin, 7);

    assert_eq!(s.client().get_run(&a.company_id, &7), a_run);
    assert_eq!(a_run.status, RunStatus::Open);
    assert!(s.client().is_paid(&a.company_id, &7, &a.workers[0]));
    assert!(!s.client().is_paid(&a.company_id, &7, &a.workers[1]));
    assert!(!s.client().is_paid(&a.company_id, &7, &b_worker));
    assert!(!s.client().is_paid(&b, &7, &a.workers[0]));
    assert_eq!(s.client().get_run(&b, &7).status, RunStatus::Closed);

    s.pay(a.company_id, 7, &a.admin, &s.items(&[&a.workers[1]]));
    assert_eq!(s.client().get_run(&a.company_id, &7).paid_count, 2);
}

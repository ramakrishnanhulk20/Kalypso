//! C4 and C5 with real signatures: every privileged call, signed for the
//! exact same invocation but by the wrong address, fails on the missing
//! signature and changes nothing. Signatures go through `mock_auths` for one
//! named address, never `mock_all_auths`.
//!
//! Not covered here: the signature cryptography itself. The host verifies it
//! on chain; `mock_auths` stands in for a valid signature by the named
//! address, and nothing else.
extern crate std;

use soroban_sdk::IntoVal;

use super::{Setup, COMPANY_AUDITOR, OTHER_AUDITOR, WORKER_AUDITOR};
use crate::{RunStatus, WorkerStatus};

#[test]
fn create_company_needs_the_named_admin_signature() {
    let s = Setup::new();
    let admin = s.account(COMPANY_AUDITOR);
    let stranger = s.account(COMPANY_AUDITOR);
    let label = s.text("Acme");

    s.sign(
        &stranger,
        "create_company",
        (&admin, COMPANY_AUDITOR, &label).into_val(&s.e),
    );

    s.assert_auth_failed(
        s.client()
            .try_create_company(&admin, &COMPANY_AUDITOR, &label),
    );
    assert_eq!(s.client().company_count(), 0);
}

#[test]
fn propose_admin_needs_the_admin_signature() {
    let s = Setup::new();
    let t = s.team(1);
    let thief = s.account(COMPANY_AUDITOR);
    let live_until = s.seq() + 100;

    s.sign(
        &thief,
        "propose_admin",
        (t.company_id, &thief, live_until).into_val(&s.e),
    );

    s.assert_auth_failed(
        s.client()
            .try_propose_admin(&t.company_id, &thief, &live_until),
    );
    assert_eq!(s.client().pending_admin(&t.company_id), None);
}

#[test]
fn cancel_admin_proposal_needs_the_admin_signature() {
    let s = Setup::new();
    let t = s.team(0);
    let successor = s.account(COMPANY_AUDITOR);
    s.propose_admin(t.company_id, &t.admin, &successor, s.seq() + 100);

    s.sign(
        &successor,
        "cancel_admin_proposal",
        (t.company_id,).into_val(&s.e),
    );

    s.assert_auth_failed(s.client().try_cancel_admin_proposal(&t.company_id));
    assert!(s.client().pending_admin(&t.company_id).is_some());
}

#[test]
fn accept_admin_needs_the_incoming_admin_signature() {
    let s = Setup::new();
    let t = s.team(0);
    let successor = s.account(COMPANY_AUDITOR);
    s.propose_admin(t.company_id, &t.admin, &successor, s.seq() + 100);

    s.sign(&t.admin, "accept_admin", (t.company_id,).into_val(&s.e));

    s.assert_auth_failed(s.client().try_accept_admin(&t.company_id));
    assert_eq!(s.client().get_company(&t.company_id).admin, t.admin);
}

#[test]
fn invite_worker_needs_the_admin_signature() {
    let s = Setup::new();
    let t = s.team(0);
    let worker = s.account(WORKER_AUDITOR);

    s.sign(
        &worker,
        "invite_worker",
        (t.company_id, &worker).into_val(&s.e),
    );

    s.assert_auth_failed(s.client().try_invite_worker(&t.company_id, &worker));
    assert_eq!(s.client().worker_status(&t.company_id, &worker), None);
}

#[test]
fn revoke_invite_needs_the_admin_signature() {
    let s = Setup::new();
    let t = s.team(0);
    let worker = s.account(WORKER_AUDITOR);
    s.invite(t.company_id, &t.admin, &worker);

    s.sign(
        &worker,
        "revoke_invite",
        (t.company_id, &worker).into_val(&s.e),
    );

    s.assert_auth_failed(s.client().try_revoke_invite(&t.company_id, &worker));
    assert_eq!(
        s.client().worker_status(&t.company_id, &worker),
        Some(WorkerStatus::Invited)
    );
}

#[test]
fn accept_invite_needs_the_worker_signature() {
    let s = Setup::new();
    let t = s.team(0);
    let worker = s.account(WORKER_AUDITOR);
    s.invite(t.company_id, &t.admin, &worker);

    s.sign(
        &t.admin,
        "accept_invite",
        (t.company_id, &worker).into_val(&s.e),
    );

    s.assert_auth_failed(s.client().try_accept_invite(&t.company_id, &worker));
    assert_eq!(
        s.client().worker_status(&t.company_id, &worker),
        Some(WorkerStatus::Invited)
    );
}

#[test]
fn remove_worker_needs_the_admin_signature() {
    let s = Setup::new();
    let t = s.team(1);

    s.sign(
        &t.workers[0],
        "remove_worker",
        (t.company_id, &t.workers[0]).into_val(&s.e),
    );

    s.assert_auth_failed(s.client().try_remove_worker(&t.company_id, &t.workers[0]));
    assert_eq!(
        s.client().worker_status(&t.company_id, &t.workers[0]),
        Some(WorkerStatus::Active)
    );
}

/// C4 and C6: another company's admin cannot open a run for this company.
#[test]
fn open_run_needs_the_admin_signature() {
    let s = Setup::new();
    let t = s.team(1);
    let other_admin = s.account(OTHER_AUDITOR);
    s.create_company(&other_admin, OTHER_AUDITOR, "Beta");
    let label = s.text("October 2026");

    s.sign(
        &other_admin,
        "open_run",
        (t.company_id, 7u64, &label, 1u32).into_val(&s.e),
    );

    s.assert_auth_failed(s.client().try_open_run(&t.company_id, &7, &label, &1));
    assert!(s.client().try_get_run(&t.company_id, &7).is_err());
}

#[test]
fn pay_needs_the_admin_signature() {
    let s = Setup::new();
    let t = s.team(1);
    s.open_run(t.company_id, &t.admin, 7, 1);
    let items = s.items(&[&t.workers[0]]);

    s.sign_pay(&t.workers[0], &t.admin, t.company_id, 7, &items);

    s.assert_auth_failed(s.client().try_pay(&t.company_id, &7, &items));
    assert!(s.transfers().is_empty());
    assert!(!s.client().is_paid(&t.company_id, &7, &t.workers[0]));
}

/// C5 and C6: company B's admin aiming at company A's treasury, by calling
/// pay on A's company id, fails on A's admin signature and moves nothing.
#[test]
fn another_company_admin_cannot_pay_from_this_company_treasury() {
    let s = Setup::new();
    let a = s.team(1);
    let b_admin = s.account(OTHER_AUDITOR);
    s.create_company(&b_admin, OTHER_AUDITOR, "Beta");
    s.open_run(a.company_id, &a.admin, 7, 1);
    let items = s.items(&[&a.workers[0]]);

    for treasury in [&a.admin, &b_admin] {
        s.sign_pay(&b_admin, treasury, a.company_id, 7, &items);
        s.assert_auth_failed(s.client().try_pay(&a.company_id, &7, &items));
    }
    assert!(s.transfers().is_empty());
    assert!(!s.client().is_paid(&a.company_id, &7, &a.workers[0]));
    assert_eq!(s.client().get_run(&a.company_id, &7).paid_count, 0);
}

#[test]
fn close_run_needs_the_admin_signature() {
    let s = Setup::new();
    let t = s.team(1);
    s.open_run(t.company_id, &t.admin, 7, 1);
    let stranger = s.account(COMPANY_AUDITOR);

    s.sign(&stranger, "close_run", (t.company_id, 7u64).into_val(&s.e));

    s.assert_auth_failed(s.client().try_close_run(&t.company_id, &7));
    assert_eq!(
        s.client().get_run(&t.company_id, &7).status,
        RunStatus::Open
    );
}

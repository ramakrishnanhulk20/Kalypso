//! invite_worker, revoke_invite, accept_invite, remove_worker, worker_status
//! and get_roster.
//!
//! Not covered here: a real token registration, and wrong-signer cases,
//! which are in auth.rs.
extern crate std;

use soroban_sdk::{Address, Event as _, IntoVal, Vec};

use super::{err, Setup, COMPANY_AUDITOR, OTHER_AUDITOR, WORKER_AUDITOR};
use crate::{
    InviteRevoked, PayrollError, WorkerInvited, WorkerJoined, WorkerRemoved, WorkerStatus,
};

#[test]
fn invite_worker_marks_the_worker_invited_and_emits_worker_invited() {
    let s = Setup::new();
    let t = s.team(0);
    let worker = s.account(WORKER_AUDITOR);

    s.invite(t.company_id, &t.admin, &worker);

    assert_eq!(
        s.payroll_events(),
        std::vec![WorkerInvited {
            company_id: t.company_id,
            worker: worker.clone(),
        }
        .to_xdr(&s.e, &s.payroll)]
    );
    assert_eq!(
        s.client().worker_status(&t.company_id, &worker),
        Some(WorkerStatus::Invited)
    );
    let company = s.client().get_company(&t.company_id);
    assert_eq!(company.active_workers, 0);
    assert_eq!(company.roster_len, 0);
}

#[test]
fn invite_worker_rejects_the_admin() {
    let s = Setup::new();
    let t = s.team(0);

    s.sign(
        &t.admin,
        "invite_worker",
        (t.company_id, &t.admin).into_val(&s.e),
    );
    assert_eq!(
        s.client().try_invite_worker(&t.company_id, &t.admin),
        Err(Ok(err(PayrollError::WorkerIsAdmin)))
    );
    assert_eq!(s.client().worker_status(&t.company_id, &t.admin), None);
}

#[test]
fn invite_worker_rejects_a_worker_already_invited_or_active() {
    let s = Setup::new();
    let t = s.team(1);
    let invited = s.account(WORKER_AUDITOR);
    s.invite(t.company_id, &t.admin, &invited);

    for worker in [&invited, &t.workers[0]] {
        s.sign(
            &t.admin,
            "invite_worker",
            (t.company_id, worker).into_val(&s.e),
        );
        assert_eq!(
            s.client().try_invite_worker(&t.company_id, worker),
            Err(Ok(err(PayrollError::AlreadyMember)))
        );
    }
    assert_eq!(
        s.client().worker_status(&t.company_id, &t.workers[0]),
        Some(WorkerStatus::Active)
    );
}

#[test]
fn worker_functions_fail_for_an_unknown_company() {
    let s = Setup::new();
    let someone = s.account(WORKER_AUDITOR);

    for fn_name in ["invite_worker", "accept_invite", "remove_worker"] {
        s.sign(&someone, fn_name, (4u64, &someone).into_val(&s.e));
        let result = match fn_name {
            "invite_worker" => s.client().try_invite_worker(&4, &someone),
            "accept_invite" => s.client().try_accept_invite(&4, &someone),
            _ => s.client().try_remove_worker(&4, &someone),
        };
        assert_eq!(result, Err(Ok(err(PayrollError::CompanyNotFound))));
    }
}

#[test]
fn accept_invite_activates_the_worker_appends_the_roster_and_emits_worker_joined() {
    let s = Setup::new();
    let t = s.team(0);
    let worker = s.account(WORKER_AUDITOR);
    s.invite(t.company_id, &t.admin, &worker);

    s.accept(t.company_id, &worker);

    assert_eq!(
        s.payroll_events(),
        std::vec![WorkerJoined {
            company_id: t.company_id,
            worker: worker.clone(),
        }
        .to_xdr(&s.e, &s.payroll)]
    );
    assert_eq!(
        s.client().worker_status(&t.company_id, &worker),
        Some(WorkerStatus::Active)
    );
    let company = s.client().get_company(&t.company_id);
    assert_eq!(company.active_workers, 1);
    assert_eq!(company.roster_len, 1);
    assert_eq!(
        s.client().get_roster(&t.company_id, &0, &50),
        Vec::from_array(&s.e, [worker])
    );
}

#[test]
fn accept_invite_rejects_a_worker_with_no_pending_invite() {
    let s = Setup::new();
    let t = s.team(2);
    let stranger = s.account(WORKER_AUDITOR);
    let removed = t.workers[1].clone();
    s.remove(t.company_id, &t.admin, &removed);

    for worker in [&stranger, &t.workers[0], &removed] {
        s.sign(
            worker,
            "accept_invite",
            (t.company_id, worker).into_val(&s.e),
        );
        assert_eq!(
            s.client().try_accept_invite(&t.company_id, worker),
            Err(Ok(err(PayrollError::InviteNotFound)))
        );
    }
    assert_eq!(s.client().get_company(&t.company_id).active_workers, 1);
}

#[test]
fn accept_invite_rejects_a_worker_not_registered_with_the_token() {
    let s = Setup::new();
    let t = s.team(0);
    let worker = s.unregistered();
    s.invite(t.company_id, &t.admin, &worker);

    s.sign(
        &worker,
        "accept_invite",
        (t.company_id, &worker).into_val(&s.e),
    );
    assert_eq!(
        s.client().try_accept_invite(&t.company_id, &worker),
        Err(Ok(err(PayrollError::NotRegisteredWithToken)))
    );
    assert!(s.payroll_events().events().is_empty());
    assert_eq!(
        s.client().worker_status(&t.company_id, &worker),
        Some(WorkerStatus::Invited)
    );
}

#[test]
fn accept_invite_takes_a_worker_under_any_auditor_id() {
    let s = Setup::new();
    let t = s.team(0);

    for auditor_id in [COMPANY_AUDITOR, OTHER_AUDITOR, 77] {
        let worker = s.account(auditor_id);
        s.join(t.company_id, &t.admin, &worker);
        assert_eq!(
            s.client().worker_status(&t.company_id, &worker),
            Some(WorkerStatus::Active)
        );
    }
    assert_eq!(s.client().get_company(&t.company_id).active_workers, 3);
}

#[test]
fn remove_worker_marks_the_worker_removed_and_emits_worker_removed() {
    let s = Setup::new();
    let t = s.team(2);

    s.remove(t.company_id, &t.admin, &t.workers[0]);

    assert_eq!(
        s.payroll_events(),
        std::vec![WorkerRemoved {
            company_id: t.company_id,
            worker: t.workers[0].clone(),
        }
        .to_xdr(&s.e, &s.payroll)]
    );
    assert_eq!(
        s.client().worker_status(&t.company_id, &t.workers[0]),
        Some(WorkerStatus::Removed)
    );
    let company = s.client().get_company(&t.company_id);
    assert_eq!(company.active_workers, 1);
    assert_eq!(company.roster_len, 2);
}

#[test]
fn remove_worker_rejects_a_worker_who_is_not_active() {
    let s = Setup::new();
    let t = s.team(1);
    let stranger = s.account(WORKER_AUDITOR);
    let invited = s.account(WORKER_AUDITOR);
    s.invite(t.company_id, &t.admin, &invited);
    s.remove(t.company_id, &t.admin, &t.workers[0]);

    for worker in [&stranger, &invited, &t.workers[0]] {
        s.sign(
            &t.admin,
            "remove_worker",
            (t.company_id, worker).into_val(&s.e),
        );
        assert_eq!(
            s.client().try_remove_worker(&t.company_id, worker),
            Err(Ok(err(PayrollError::NotActive)))
        );
    }
    assert_eq!(s.client().get_company(&t.company_id).active_workers, 0);
}

#[test]
fn a_removed_worker_can_rejoin_without_a_second_roster_entry() {
    let s = Setup::new();
    let t = s.team(2);
    s.remove(t.company_id, &t.admin, &t.workers[0]);

    s.join(t.company_id, &t.admin, &t.workers[0]);

    assert_eq!(
        s.client().worker_status(&t.company_id, &t.workers[0]),
        Some(WorkerStatus::Active)
    );
    let company = s.client().get_company(&t.company_id);
    assert_eq!(company.active_workers, 2);
    assert_eq!(company.roster_len, 2);
    assert_eq!(
        s.client().get_roster(&t.company_id, &0, &50),
        Vec::from_array(&s.e, [t.workers[0].clone(), t.workers[1].clone()])
    );
}

#[test]
fn get_roster_pages_through_the_roster_in_join_order() {
    let s = Setup::new();
    let t = s.team(5);
    let page = |start: u32, limit: u32| s.client().get_roster(&t.company_id, &start, &limit);
    let expected = |range: core::ops::Range<usize>| {
        let mut out: Vec<Address> = Vec::new(&s.e);
        for worker in &t.workers[range] {
            out.push_back(worker.clone());
        }
        out
    };

    assert_eq!(page(0, 2), expected(0..2));
    assert_eq!(page(2, 2), expected(2..4));
    assert_eq!(page(4, 2), expected(4..5));
    assert_eq!(page(5, 2), expected(5..5));
    assert_eq!(page(u32::MAX, 50), expected(5..5));
    assert_eq!(page(0, 50), expected(0..5));
}

#[test]
fn get_roster_rejects_a_limit_of_zero_or_above_fifty() {
    let s = Setup::new();
    let t = s.team(1);

    for limit in [0u32, 51] {
        assert_eq!(
            s.client().try_get_roster(&t.company_id, &0, &limit),
            Err(Ok(err(PayrollError::LimitInvalid)))
        );
    }
}

#[test]
fn get_roster_fails_for_an_unknown_company() {
    let s = Setup::new();

    assert_eq!(
        s.client().try_get_roster(&3, &0, &10),
        Err(Ok(err(PayrollError::CompanyNotFound)))
    );
}

/// The admin cannot join its own payroll. The first case is reachable: the
/// admin simply calls accept_invite for itself. The second forces an invite
/// for the admin into storage, a state invite_worker and accept_admin never
/// produce, to show this check holds on its own.
#[test]
fn accept_invite_refuses_the_current_admin() {
    let s = Setup::new();
    let t = s.team(0);

    s.sign(
        &t.admin,
        "accept_invite",
        (t.company_id, &t.admin).into_val(&s.e),
    );
    assert_eq!(
        s.client().try_accept_invite(&t.company_id, &t.admin),
        Err(Ok(err(PayrollError::WorkerIsAdmin)))
    );

    s.force_worker_status(t.company_id, &t.admin, WorkerStatus::Invited);
    s.sign(
        &t.admin,
        "accept_invite",
        (t.company_id, &t.admin).into_val(&s.e),
    );
    assert_eq!(
        s.client().try_accept_invite(&t.company_id, &t.admin),
        Err(Ok(err(PayrollError::WorkerIsAdmin)))
    );
    assert!(s.payroll_events().events().is_empty());
    assert_eq!(
        s.client().worker_status(&t.company_id, &t.admin),
        Some(WorkerStatus::Invited)
    );
    let company = s.client().get_company(&t.company_id);
    assert_eq!(company.active_workers, 0);
    assert_eq!(company.roster_len, 0);
}

#[test]
fn revoke_invite_marks_the_invite_removed_and_emits_invite_revoked() {
    let s = Setup::new();
    let t = s.team(0);
    let worker = s.account(WORKER_AUDITOR);
    s.invite(t.company_id, &t.admin, &worker);

    s.revoke(t.company_id, &t.admin, &worker);

    assert_eq!(
        s.payroll_events(),
        std::vec![InviteRevoked {
            company_id: t.company_id,
            worker: worker.clone(),
        }
        .to_xdr(&s.e, &s.payroll)]
    );
    assert_eq!(
        s.client().worker_status(&t.company_id, &worker),
        Some(WorkerStatus::Removed)
    );
    let company = s.client().get_company(&t.company_id);
    assert_eq!(company.active_workers, 0);
    assert_eq!(company.roster_len, 0);
    s.sign(
        &worker,
        "accept_invite",
        (t.company_id, &worker).into_val(&s.e),
    );
    assert_eq!(
        s.client().try_accept_invite(&t.company_id, &worker),
        Err(Ok(err(PayrollError::InviteNotFound)))
    );

    s.join(t.company_id, &t.admin, &worker);
    assert_eq!(
        s.client().get_roster(&t.company_id, &0, &50),
        Vec::from_array(&s.e, [worker])
    );
}

#[test]
fn revoke_invite_rejects_a_worker_without_a_pending_invite() {
    let s = Setup::new();
    let t = s.team(2);
    let stranger = s.account(WORKER_AUDITOR);
    let removed = t.workers[1].clone();
    s.remove(t.company_id, &t.admin, &removed);

    for worker in [&stranger, &t.workers[0], &removed] {
        s.sign(
            &t.admin,
            "revoke_invite",
            (t.company_id, worker).into_val(&s.e),
        );
        assert_eq!(
            s.client().try_revoke_invite(&t.company_id, worker),
            Err(Ok(err(PayrollError::InviteNotFound)))
        );
    }
    assert_eq!(
        s.client().worker_status(&t.company_id, &t.workers[0]),
        Some(WorkerStatus::Active)
    );
    s.sign(
        &t.admin,
        "revoke_invite",
        (9u64, &stranger).into_val(&s.e),
    );
    assert_eq!(
        s.client().try_revoke_invite(&9, &stranger),
        Err(Ok(err(PayrollError::CompanyNotFound)))
    );
}

/// A worker who joined, left and was invited back keeps their one roster
/// entry when the new invite is revoked.
#[test]
fn revoking_a_returning_workers_invite_leaves_the_roster_alone() {
    let s = Setup::new();
    let t = s.team(2);
    s.remove(t.company_id, &t.admin, &t.workers[0]);
    s.invite(t.company_id, &t.admin, &t.workers[0]);

    s.revoke(t.company_id, &t.admin, &t.workers[0]);

    let company = s.client().get_company(&t.company_id);
    assert_eq!(company.roster_len, 2);
    assert_eq!(company.active_workers, 1);
    assert_eq!(
        s.client().get_roster(&t.company_id, &0, &50),
        Vec::from_array(&s.e, [t.workers[0].clone(), t.workers[1].clone()])
    );
    s.join(t.company_id, &t.admin, &t.workers[0]);
    assert_eq!(s.client().get_company(&t.company_id).roster_len, 2);
}

#[test]
fn a_worker_in_one_company_is_unknown_to_another() {
    let s = Setup::new();
    let t = s.team(1);
    let other_admin = s.account(OTHER_AUDITOR);
    let other = s.create_company(&other_admin, OTHER_AUDITOR, "Beta");

    assert_eq!(s.client().worker_status(&other, &t.workers[0]), None);
    assert_eq!(s.client().get_roster(&other, &0, &50).len(), 0);
}

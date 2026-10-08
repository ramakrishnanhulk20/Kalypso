//! invite_worker, revoke_invite, accept_invite, remove_worker, worker_status,
//! get_roster and memberships_of.
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

/// accept_invite writes every roster index below roster_len. With one entry
/// deleted straight from storage, get_roster fails with MissingRecord instead
/// of returning a short page, and a page that starts past the gap still reads.
#[test]
fn get_roster_fails_with_missing_record_when_an_entry_is_gone() {
    let s = Setup::new();
    let t = s.team(2);
    let gap = s.key("RosterAt", (t.company_id, 0u32));
    s.e.as_contract(&s.payroll, || s.e.storage().persistent().remove(&gap));

    assert_eq!(
        s.client().try_get_roster(&t.company_id, &0, &50),
        Err(Ok(err(PayrollError::MissingRecord)))
    );
    assert_eq!(
        s.client().get_roster(&t.company_id, &1, &50),
        Vec::from_array(&s.e, [t.workers[1].clone()])
    );
}

/// The roster length is forced to the u32 limit. A new worker's accept is
/// refused with CounterOverflow, and the roster entry written just before
/// the check is undone with the rest of the call.
#[test]
fn accept_invite_refuses_when_the_roster_length_is_at_its_limit() {
    let s = Setup::new();
    let t = s.team(0);
    let worker = s.account(WORKER_AUDITOR);
    s.invite(t.company_id, &t.admin, &worker);
    s.force_company(t.company_id, |company| company.roster_len = u32::MAX);
    s.sign(
        &worker,
        "accept_invite",
        (t.company_id, &worker).into_val(&s.e),
    );

    assert_eq!(
        s.client().try_accept_invite(&t.company_id, &worker),
        Err(Ok(err(PayrollError::CounterOverflow)))
    );
    assert!(s.payroll_events().events().is_empty());
    assert_eq!(
        s.client().worker_status(&t.company_id, &worker),
        Some(WorkerStatus::Invited)
    );
    let company = s.client().get_company(&t.company_id);
    assert_eq!(company.roster_len, u32::MAX);
    assert_eq!(company.active_workers, 0);
    let last_slot = s.key("RosterAt", (t.company_id, u32::MAX));
    assert!(!s
        .e
        .as_contract(&s.payroll, || s.e.storage().persistent().has(&last_slot)));
}

/// The active worker count is forced to the u32 limit. Accepting is refused
/// with CounterOverflow and the worker stays invited.
#[test]
fn accept_invite_refuses_when_the_active_worker_count_is_at_its_limit() {
    let s = Setup::new();
    let t = s.team(0);
    let worker = s.account(WORKER_AUDITOR);
    s.invite(t.company_id, &t.admin, &worker);
    s.force_company(t.company_id, |company| company.active_workers = u32::MAX);
    s.sign(
        &worker,
        "accept_invite",
        (t.company_id, &worker).into_val(&s.e),
    );

    assert_eq!(
        s.client().try_accept_invite(&t.company_id, &worker),
        Err(Ok(err(PayrollError::CounterOverflow)))
    );
    assert!(s.payroll_events().events().is_empty());
    assert_eq!(
        s.client().worker_status(&t.company_id, &worker),
        Some(WorkerStatus::Invited)
    );
    let company = s.client().get_company(&t.company_id);
    assert_eq!(company.active_workers, u32::MAX);
    assert_eq!(company.roster_len, 0);
}

/// The active worker count is forced to zero while a worker is still active,
/// a state no public call produces. remove_worker is refused with
/// CounterOverflow instead of wrapping the count to the u32 limit.
#[test]
fn remove_worker_refuses_when_the_active_worker_count_is_already_zero() {
    let s = Setup::new();
    let t = s.team(1);
    s.force_company(t.company_id, |company| company.active_workers = 0);
    s.sign(
        &t.admin,
        "remove_worker",
        (t.company_id, &t.workers[0]).into_val(&s.e),
    );

    assert_eq!(
        s.client().try_remove_worker(&t.company_id, &t.workers[0]),
        Err(Ok(err(PayrollError::CounterOverflow)))
    );
    assert!(s.payroll_events().events().is_empty());
    assert_eq!(
        s.client().worker_status(&t.company_id, &t.workers[0]),
        Some(WorkerStatus::Active)
    );
    assert_eq!(s.client().get_company(&t.company_id).active_workers, 0);
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

/// History readers compare memberships_of with the companies they hold for
/// a worker. It counts each company the worker joins for the first time; a
/// revoked invite, a refused accept, a removal and a rejoin after removal
/// leave it alone, and a stranger reads 0.
#[test]
fn memberships_of_counts_first_joins_across_companies_and_nothing_else() {
    let s = Setup::new();
    let a = s.team(0);
    let b_admin = s.account(OTHER_AUDITOR);
    let b = s.create_company(&b_admin, OTHER_AUDITOR, "Beta");
    let c_admin = s.account(COMPANY_AUDITOR);
    let c = s.create_company(&c_admin, COMPANY_AUDITOR, "Gamma");
    let worker = s.account(WORKER_AUDITOR);
    let memberships = || s.client().memberships_of(&worker);
    assert_eq!(s.client().memberships_of(&s.unregistered()), 0);
    assert_eq!(memberships(), 0);

    s.invite(a.company_id, &a.admin, &worker);
    s.revoke(a.company_id, &a.admin, &worker);
    s.sign(
        &worker,
        "accept_invite",
        (a.company_id, &worker).into_val(&s.e),
    );
    assert_eq!(
        s.client().try_accept_invite(&a.company_id, &worker),
        Err(Ok(err(PayrollError::InviteNotFound)))
    );
    assert_eq!(memberships(), 0);

    s.join(a.company_id, &a.admin, &worker);
    assert_eq!(memberships(), 1);
    s.remove(a.company_id, &a.admin, &worker);
    assert_eq!(memberships(), 1);
    s.join(a.company_id, &a.admin, &worker);
    assert_eq!(memberships(), 1);

    s.join(b, &b_admin, &worker);
    s.join(c, &c_admin, &worker);
    assert_eq!(memberships(), 3);
    s.remove(b, &b_admin, &worker);
    assert_eq!(memberships(), 3);
}

/// The worker's membership count is forced to the u32 limit. A first join is
/// refused with CounterOverflow, and the roster entry written before the
/// check is undone with the rest of the call. A worker already on a roster
/// can still rejoin at the limit, because a rejoin does not count.
#[test]
fn accept_invite_refuses_a_first_join_when_the_membership_count_is_at_its_limit() {
    let s = Setup::new();
    let t = s.team(1);
    let newcomer = s.account(WORKER_AUDITOR);
    s.invite(t.company_id, &t.admin, &newcomer);
    let returning = t.workers[0].clone();
    s.remove(t.company_id, &t.admin, &returning);
    s.invite(t.company_id, &t.admin, &returning);
    for worker in [&newcomer, &returning] {
        s.e.as_contract(&s.payroll, || {
            crate::storage::set_memberships(&s.e, worker, u32::MAX)
        });
    }
    s.sign(
        &newcomer,
        "accept_invite",
        (t.company_id, &newcomer).into_val(&s.e),
    );

    assert_eq!(
        s.client().try_accept_invite(&t.company_id, &newcomer),
        Err(Ok(err(PayrollError::CounterOverflow)))
    );
    assert!(s.payroll_events().events().is_empty());
    assert_eq!(
        s.client().worker_status(&t.company_id, &newcomer),
        Some(WorkerStatus::Invited)
    );
    assert_eq!(s.client().memberships_of(&newcomer), u32::MAX);
    let company = s.client().get_company(&t.company_id);
    assert_eq!(company.roster_len, 1);
    assert_eq!(company.active_workers, 0);
    let slot = s.key("RosterAt", (t.company_id, 1u32));
    assert!(!s
        .e
        .as_contract(&s.payroll, || s.e.storage().persistent().has(&slot)));

    s.accept(t.company_id, &returning);
    assert_eq!(
        s.client().worker_status(&t.company_id, &returning),
        Some(WorkerStatus::Active)
    );
    assert_eq!(s.client().memberships_of(&returning), u32::MAX);
}

//! The two-step admin handover: propose_admin, cancel_admin_proposal,
//! accept_admin and pending_admin, plus who pays after a handover and the
//! company's admin_changes counter.
//!
//! Not covered here: a real token registration, and wrong-signer cases,
//! which are in auth.rs.
extern crate std;

use soroban_sdk::{Event as _, IntoVal};

use super::{err, Setup, COMPANY_AUDITOR, OTHER_AUDITOR};
use crate::{
    AdminChanged, AdminProposalCancelled, AdminProposed, PayrollError, PendingAdmin,
    WorkerStatus, DAY_IN_LEDGERS, RECORD_EXTEND_THRESHOLD, RECORD_EXTEND_TO,
};

#[test]
fn propose_admin_stores_the_proposal_and_emits_admin_proposed() {
    let s = Setup::new();
    let t = s.team(0);
    let successor = s.account(COMPANY_AUDITOR);
    let live_until = s.seq() + 100;

    s.propose_admin(t.company_id, &t.admin, &successor, live_until);

    assert_eq!(
        s.payroll_events(),
        std::vec![AdminProposed {
            company_id: t.company_id,
            new_admin: successor.clone(),
            live_until_ledger: live_until,
        }
        .to_xdr(&s.e, &s.payroll)]
    );
    assert_eq!(
        s.client().pending_admin(&t.company_id),
        Some(PendingAdmin {
            new_admin: successor,
            live_until_ledger: live_until,
        })
    );
    assert_eq!(s.client().get_company(&t.company_id).admin, t.admin);
}

#[test]
fn propose_admin_replaces_an_earlier_proposal() {
    let s = Setup::new();
    let t = s.team(0);
    let first = s.account(COMPANY_AUDITOR);
    let second = s.account(COMPANY_AUDITOR);

    s.propose_admin(t.company_id, &t.admin, &first, s.seq() + 100);
    s.propose_admin(t.company_id, &t.admin, &second, s.seq() + 50);

    assert_eq!(
        s.client().pending_admin(&t.company_id),
        Some(PendingAdmin {
            new_admin: second,
            live_until_ledger: s.seq() + 50,
        })
    );
    s.sign(&first, "accept_admin", (t.company_id,).into_val(&s.e));
    s.assert_auth_failed(s.client().try_accept_admin(&t.company_id));
}

#[test]
fn propose_admin_rejects_a_live_until_not_after_the_current_ledger() {
    let s = Setup::new();
    let t = s.team(0);
    let successor = s.account(COMPANY_AUDITOR);

    for live_until in [s.seq(), s.seq() - 1] {
        s.sign(
            &t.admin,
            "propose_admin",
            (t.company_id, &successor, live_until).into_val(&s.e),
        );
        assert_eq!(
            s.client()
                .try_propose_admin(&t.company_id, &successor, &live_until),
            Err(Ok(err(PayrollError::InvalidLiveUntil)))
        );
    }
    assert_eq!(s.client().pending_admin(&t.company_id), None);
}

/// C44: the furthest deadline accepted is the network's
/// max_live_until_ledger, the same bound the auditor registry sets. One
/// ledger past it, and u32::MAX, are refused and store nothing; exactly on
/// it the proposal is stored.
#[test]
fn propose_admin_accepts_a_deadline_up_to_the_longest_entry_lifetime_and_no_further() {
    let s = Setup::new();
    let t = s.team(0);
    let successor = s.account(COMPANY_AUDITOR);
    let furthest = s.e.ledger().max_live_until_ledger();

    for live_until in [furthest + 1, u32::MAX] {
        s.sign(
            &t.admin,
            "propose_admin",
            (t.company_id, &successor, live_until).into_val(&s.e),
        );
        assert_eq!(
            s.client()
                .try_propose_admin(&t.company_id, &successor, &live_until),
            Err(Ok(err(PayrollError::InvalidLiveUntil)))
        );
        assert!(s.payroll_events().events().is_empty());
    }
    assert_eq!(s.client().pending_admin(&t.company_id), None);

    s.propose_admin(t.company_id, &t.admin, &successor, furthest);

    assert_eq!(
        s.client().pending_admin(&t.company_id),
        Some(PendingAdmin {
            new_admin: successor,
            live_until_ledger: furthest,
        })
    );
}

/// History readers compare admin_changes with the AdminChanged events they
/// hold. It counts each completed handover; a proposal, a cancellation and
/// an accept that comes too late leave it alone.
#[test]
fn admin_changes_counts_each_accepted_handover_and_nothing_else() {
    let s = Setup::new();
    let t = s.team(0);
    let admin_changes = || s.client().get_company(&t.company_id).admin_changes;
    let first = s.account(COMPANY_AUDITOR);
    let second = s.account(COMPANY_AUDITOR);
    assert_eq!(admin_changes(), 0);

    s.propose_admin(t.company_id, &t.admin, &first, s.seq() + 10);
    assert_eq!(admin_changes(), 0);
    s.sign(
        &t.admin,
        "cancel_admin_proposal",
        (t.company_id,).into_val(&s.e),
    );
    s.client().cancel_admin_proposal(&t.company_id);
    assert_eq!(admin_changes(), 0);
    s.propose_admin(t.company_id, &t.admin, &first, s.seq() + 10);
    s.advance(11);
    s.sign(&first, "accept_admin", (t.company_id,).into_val(&s.e));
    assert_eq!(
        s.client().try_accept_admin(&t.company_id),
        Err(Ok(err(PayrollError::AdminTransferExpired)))
    );
    assert_eq!(admin_changes(), 0);

    s.propose_admin(t.company_id, &t.admin, &first, s.seq() + 10);
    s.accept_admin(t.company_id, &first);
    assert_eq!(admin_changes(), 1);
    s.propose_admin(t.company_id, &first, &second, s.seq() + 10);
    s.accept_admin(t.company_id, &second);
    assert_eq!(admin_changes(), 2);
    assert_eq!(s.client().get_company(&t.company_id).admin, second);
}

/// admin_changes is forced to the u32 limit, which no real sequence of calls
/// reaches. accept_admin is refused with CounterOverflow, the admin stays,
/// and the proposal is still pending.
#[test]
fn accept_admin_refuses_when_admin_changes_is_at_its_limit() {
    let s = Setup::new();
    let t = s.team(0);
    let successor = s.account(COMPANY_AUDITOR);
    s.propose_admin(t.company_id, &t.admin, &successor, s.seq() + 10);
    s.force_company(t.company_id, |company| company.admin_changes = u32::MAX);

    s.sign(&successor, "accept_admin", (t.company_id,).into_val(&s.e));
    assert_eq!(
        s.client().try_accept_admin(&t.company_id),
        Err(Ok(err(PayrollError::CounterOverflow)))
    );

    assert!(s.payroll_events().events().is_empty());
    let company = s.client().get_company(&t.company_id);
    assert_eq!(company.admin, t.admin);
    assert_eq!(company.admin_changes, u32::MAX);
    assert_eq!(
        s.client().pending_admin(&t.company_id).map(|p| p.new_admin),
        Some(successor)
    );
}

#[test]
fn admin_functions_fail_for_an_unknown_company() {
    let s = Setup::new();
    let someone = s.account(COMPANY_AUDITOR);
    let live_until = s.seq() + 10;

    s.sign(
        &someone,
        "propose_admin",
        (9u64, &someone, live_until).into_val(&s.e),
    );
    assert_eq!(
        s.client().try_propose_admin(&9, &someone, &live_until),
        Err(Ok(err(PayrollError::CompanyNotFound)))
    );
    s.sign(&someone, "cancel_admin_proposal", (9u64,).into_val(&s.e));
    assert_eq!(
        s.client().try_cancel_admin_proposal(&9),
        Err(Ok(err(PayrollError::CompanyNotFound)))
    );
    s.sign(&someone, "accept_admin", (9u64,).into_val(&s.e));
    assert_eq!(
        s.client().try_accept_admin(&9),
        Err(Ok(err(PayrollError::CompanyNotFound)))
    );
}

#[test]
fn cancel_admin_proposal_clears_it_and_emits_admin_proposal_cancelled() {
    let s = Setup::new();
    let t = s.team(0);
    let successor = s.account(COMPANY_AUDITOR);
    s.propose_admin(t.company_id, &t.admin, &successor, s.seq() + 100);

    s.sign(
        &t.admin,
        "cancel_admin_proposal",
        (t.company_id,).into_val(&s.e),
    );
    s.client().cancel_admin_proposal(&t.company_id);

    assert_eq!(
        s.payroll_events(),
        std::vec![AdminProposalCancelled {
            company_id: t.company_id,
        }
        .to_xdr(&s.e, &s.payroll)]
    );
    assert_eq!(s.client().pending_admin(&t.company_id), None);
    s.sign(&successor, "accept_admin", (t.company_id,).into_val(&s.e));
    assert_eq!(
        s.client().try_accept_admin(&t.company_id),
        Err(Ok(err(PayrollError::NoPendingAdmin)))
    );
}

#[test]
fn cancel_admin_proposal_fails_with_nothing_pending() {
    let s = Setup::new();
    let t = s.team(0);

    s.sign(
        &t.admin,
        "cancel_admin_proposal",
        (t.company_id,).into_val(&s.e),
    );
    assert_eq!(
        s.client().try_cancel_admin_proposal(&t.company_id),
        Err(Ok(err(PayrollError::NoPendingAdmin)))
    );
}

#[test]
fn accept_admin_hands_over_and_emits_admin_changed() {
    let s = Setup::new();
    let t = s.team(0);
    let successor = s.account(COMPANY_AUDITOR);
    s.propose_admin(t.company_id, &t.admin, &successor, s.seq() + 100);

    s.accept_admin(t.company_id, &successor);

    assert_eq!(
        s.payroll_events(),
        std::vec![AdminChanged {
            company_id: t.company_id,
            previous_admin: t.admin.clone(),
            new_admin: successor.clone(),
        }
        .to_xdr(&s.e, &s.payroll)]
    );
    let company = s.client().get_company(&t.company_id);
    assert_eq!(company.admin, successor);
    assert_eq!(company.auditor_id, COMPANY_AUDITOR);
    assert_eq!(s.client().pending_admin(&t.company_id), None);
}

#[test]
fn accept_admin_succeeds_on_the_last_live_ledger_and_fails_after_it() {
    let on_time = Setup::new();
    let t = on_time.team(0);
    let successor = on_time.account(COMPANY_AUDITOR);
    on_time.propose_admin(t.company_id, &t.admin, &successor, on_time.seq() + 10);
    on_time.advance(10);
    on_time.accept_admin(t.company_id, &successor);
    assert_eq!(on_time.client().get_company(&t.company_id).admin, successor);

    let late = Setup::new();
    let t = late.team(0);
    let successor = late.account(COMPANY_AUDITOR);
    late.propose_admin(t.company_id, &t.admin, &successor, late.seq() + 10);
    late.advance(11);
    late.sign(&successor, "accept_admin", (t.company_id,).into_val(&late.e));
    assert_eq!(
        late.client().try_accept_admin(&t.company_id),
        Err(Ok(err(PayrollError::AdminTransferExpired)))
    );
    assert_eq!(late.client().get_company(&t.company_id).admin, t.admin);
}

#[test]
fn accept_admin_fails_with_nothing_pending() {
    let s = Setup::new();
    let t = s.team(0);
    let someone = s.account(COMPANY_AUDITOR);

    s.sign(&someone, "accept_admin", (t.company_id,).into_val(&s.e));
    assert_eq!(
        s.client().try_accept_admin(&t.company_id),
        Err(Ok(err(PayrollError::NoPendingAdmin)))
    );
}

#[test]
fn accept_admin_rejects_an_incoming_admin_not_registered_with_the_token() {
    let s = Setup::new();
    let t = s.team(0);
    let successor = s.unregistered();
    s.propose_admin(t.company_id, &t.admin, &successor, s.seq() + 100);

    s.sign(&successor, "accept_admin", (t.company_id,).into_val(&s.e));
    assert_eq!(
        s.client().try_accept_admin(&t.company_id),
        Err(Ok(err(PayrollError::NotRegisteredWithToken)))
    );
    assert!(s.payroll_events().events().is_empty());
    assert_eq!(s.client().get_company(&t.company_id).admin, t.admin);
}

/// C9: a handover to an account registered under another auditor id is
/// refused, so the company's accountant never loses sight of its payments.
#[test]
fn accept_admin_rejects_an_incoming_admin_under_another_auditor_id() {
    let s = Setup::new();
    let t = s.team(0);
    let successor = s.account(OTHER_AUDITOR);
    s.propose_admin(t.company_id, &t.admin, &successor, s.seq() + 100);

    s.sign(&successor, "accept_admin", (t.company_id,).into_val(&s.e));
    assert_eq!(
        s.client().try_accept_admin(&t.company_id),
        Err(Ok(err(PayrollError::AuditorMismatch)))
    );
    assert!(s.payroll_events().events().is_empty());
    assert_eq!(s.client().get_company(&t.company_id).admin, t.admin);
    assert!(s.client().pending_admin(&t.company_id).is_some());
}

/// C5: after a handover the money comes from the new admin, and the old admin
/// can no longer pay.
#[test]
fn after_a_handover_pay_moves_money_from_the_new_admin_only() {
    let s = Setup::new();
    let t = s.team(2);
    s.open_run(t.company_id, &t.admin, 7, 2);
    let successor = s.account(COMPANY_AUDITOR);
    s.propose_admin(t.company_id, &t.admin, &successor, s.seq() + 100);
    s.accept_admin(t.company_id, &successor);

    let items = s.items(&[&t.workers[0]]);
    s.sign_pay(&t.admin, &t.admin, t.company_id, 7, &items);
    s.assert_auth_failed(s.client().try_pay(&t.company_id, &7, &items));
    s.sign_pay(&t.admin, &successor, t.company_id, 7, &items);
    s.assert_auth_failed(s.client().try_pay(&t.company_id, &7, &items));
    assert!(s.transfers().is_empty());

    s.pay(t.company_id, 7, &successor, &items);

    let transfers = s.transfers();
    assert_eq!(transfers.len(), 1);
    let transfer = transfers.get(0).unwrap();
    assert_eq!(transfer.from, successor);
    assert_eq!(transfer.to, t.workers[0]);
}

/// The treasury is never also a worker: a handover to someone invited to or
/// active in the company is refused, and the proposal stays pending.
#[test]
fn accept_admin_refuses_a_worker_who_is_invited_or_active_here() {
    let s = Setup::new();
    let t = s.team(0);
    let active = s.account(COMPANY_AUDITOR);
    s.join(t.company_id, &t.admin, &active);
    let invited = s.account(COMPANY_AUDITOR);
    s.invite(t.company_id, &t.admin, &invited);

    for worker in [&active, &invited] {
        s.propose_admin(t.company_id, &t.admin, worker, s.seq() + 100);
        s.sign(worker, "accept_admin", (t.company_id,).into_val(&s.e));
        assert_eq!(
            s.client().try_accept_admin(&t.company_id),
            Err(Ok(err(PayrollError::WorkerIsAdmin)))
        );
        assert!(s.payroll_events().events().is_empty());
        assert_eq!(s.client().get_company(&t.company_id).admin, t.admin);
        assert_eq!(
            s.client().pending_admin(&t.company_id).map(|p| p.new_admin),
            Some(worker.clone())
        );
    }
}

/// The scenario that used to end in the treasury paying itself: an active
/// worker is proposed as admin and accepts. The handover is now refused, so
/// the next pay still moves money from the real admin to the worker.
#[test]
fn handing_the_company_to_an_active_worker_is_refused_so_pay_never_pays_itself() {
    let s = Setup::new();
    let t = s.team(0);
    let worker = s.account(COMPANY_AUDITOR);
    s.join(t.company_id, &t.admin, &worker);
    s.open_run(t.company_id, &t.admin, 7, 1);
    s.propose_admin(t.company_id, &t.admin, &worker, s.seq() + 100);

    s.sign(&worker, "accept_admin", (t.company_id,).into_val(&s.e));
    assert_eq!(
        s.client().try_accept_admin(&t.company_id),
        Err(Ok(err(PayrollError::WorkerIsAdmin)))
    );
    s.pay(t.company_id, 7, &t.admin, &s.items(&[&worker]));

    let transfers = s.transfers();
    assert_eq!(transfers.len(), 1);
    let transfer = transfers.get(0).unwrap();
    assert_eq!(transfer.from, t.admin);
    assert_eq!(transfer.to, worker);
}

/// A removed worker may become admin, and from then on cannot rejoin or be
/// paid by the company. accept_admin also extends the worker record it read.
#[test]
fn a_removed_worker_may_become_admin_and_then_cannot_be_a_worker() {
    let s = Setup::new();
    let t = s.team(1);
    let former = s.account(COMPANY_AUDITOR);
    s.join(t.company_id, &t.admin, &former);
    s.remove(t.company_id, &t.admin, &former);
    s.open_run(t.company_id, &t.admin, 7, 1);
    s.propose_admin(t.company_id, &t.admin, &former, s.seq() + 2 * DAY_IN_LEDGERS);
    let record = s.key("Worker", (t.company_id, &former));
    s.advance(DAY_IN_LEDGERS + 1);
    assert!(s.record_ttl(record) < RECORD_EXTEND_THRESHOLD);

    s.accept_admin(t.company_id, &former);

    assert_eq!(s.client().get_company(&t.company_id).admin, former);
    assert_eq!(s.record_ttl(record), RECORD_EXTEND_TO);
    assert_eq!(
        s.client().worker_status(&t.company_id, &former),
        Some(WorkerStatus::Removed)
    );
    s.sign(
        &former,
        "invite_worker",
        (t.company_id, &former).into_val(&s.e),
    );
    assert_eq!(
        s.client().try_invite_worker(&t.company_id, &former),
        Err(Ok(err(PayrollError::WorkerIsAdmin)))
    );
    let to_self = s.items(&[&former]);
    s.sign_pay(&former, &former, t.company_id, 7, &to_self);
    assert_eq!(
        s.client().try_pay(&t.company_id, &7, &to_self),
        Err(Ok(err(PayrollError::WorkerIsAdmin)))
    );
    assert!(s.transfers().is_empty());
}

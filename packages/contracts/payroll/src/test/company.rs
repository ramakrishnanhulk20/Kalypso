//! The constructor, create_company and the read-only functions.
//!
//! Not covered here: a real token registration (the mock reports whatever
//! auditor id the test chose), and how a frontend renders or exports labels,
//! which is the off-chain half of C25. Wrong-signer cases are in auth.rs.
extern crate std;

use soroban_sdk::{Event as _, IntoVal, String};

use super::{err, Setup, COMPANY_AUDITOR, OTHER_AUDITOR};
use crate::{Company, CompanyCreated, PayrollError, RunStatus, WorkerStatus};

#[test]
fn constructor_binds_the_token_and_starts_with_no_companies() {
    let s = Setup::new();

    assert_eq!(s.client().token(), s.token);
    assert_eq!(s.client().company_count(), 0);
}

#[test]
fn create_company_stores_the_company_and_emits_company_created() {
    let s = Setup::new();
    let admin = s.account(COMPANY_AUDITOR);
    let label = s.text("Acme");
    s.sign(
        &admin,
        "create_company",
        (&admin, COMPANY_AUDITOR, &label).into_val(&s.e),
    );

    let company_id = s
        .client()
        .create_company(&admin, &COMPANY_AUDITOR, &label);

    assert_eq!(
        s.payroll_events(),
        std::vec![CompanyCreated {
            company_id: 0,
            admin: admin.clone(),
            auditor_id: COMPANY_AUDITOR,
            label: label.clone(),
        }
        .to_xdr(&s.e, &s.payroll)]
    );
    assert_eq!(company_id, 0);
    assert_eq!(
        s.client().get_company(&0),
        Company {
            admin,
            auditor_id: COMPANY_AUDITOR,
            label,
            created_ledger: 1_000,
            active_workers: 0,
            roster_len: 0,
        }
    );
    assert_eq!(s.client().company_count(), 1);
}

#[test]
fn company_ids_count_up_from_zero_and_one_admin_may_run_two_companies() {
    let s = Setup::new();
    let first = s.account(COMPANY_AUDITOR);
    let second = s.account(OTHER_AUDITOR);

    assert_eq!(s.create_company(&first, COMPANY_AUDITOR, "Acme"), 0);
    assert_eq!(s.create_company(&second, OTHER_AUDITOR, "Beta"), 1);
    assert_eq!(s.create_company(&first, COMPANY_AUDITOR, "Acme Labs"), 2);
    assert_eq!(s.client().company_count(), 3);
    assert_eq!(s.client().get_company(&1).admin, second);
}

/// The next company id is forced to the u64 limit, because no real sequence
/// of calls gets there. create_company is refused with CounterOverflow and
/// stores nothing, so the counter can never wrap back onto company 0.
#[test]
fn create_company_refuses_when_company_ids_run_out() {
    let s = Setup::new();
    let first = s.account(COMPANY_AUDITOR);
    s.create_company(&first, COMPANY_AUDITOR, "Acme");
    s.e.as_contract(&s.payroll, || {
        crate::storage::set_next_company_id(&s.e, u64::MAX);
    });
    let admin = s.account(OTHER_AUDITOR);
    let label = s.text("Beta");
    s.sign(
        &admin,
        "create_company",
        (&admin, OTHER_AUDITOR, &label).into_val(&s.e),
    );

    let result = s
        .client()
        .try_create_company(&admin, &OTHER_AUDITOR, &label);

    assert_eq!(result, Err(Ok(err(PayrollError::CounterOverflow))));
    assert!(s.payroll_events().events().is_empty());
    assert_eq!(s.client().company_count(), u64::MAX);
    assert_eq!(
        s.client().try_get_company(&u64::MAX),
        Err(Ok(err(PayrollError::CompanyNotFound)))
    );
    assert_eq!(s.client().get_company(&0).admin, first);
}

/// The constructor writes the token address and nothing removes it. With it
/// deleted straight from storage, every call that needs the token fails with
/// MissingRecord rather than an unnamed trap.
#[test]
fn a_missing_token_address_fails_with_missing_record() {
    let s = Setup::new();
    let admin = s.account(COMPANY_AUDITOR);
    s.e.as_contract(&s.payroll, || {
        s.e.storage().instance().remove(&s.key("Token", ()));
    });

    assert_eq!(
        s.client().try_token(),
        Err(Ok(err(PayrollError::MissingRecord)))
    );
    let label = s.text("Acme");
    s.sign(
        &admin,
        "create_company",
        (&admin, COMPANY_AUDITOR, &label).into_val(&s.e),
    );
    assert_eq!(
        s.client()
            .try_create_company(&admin, &COMPANY_AUDITOR, &label),
        Err(Ok(err(PayrollError::MissingRecord)))
    );
    assert_eq!(s.client().company_count(), 0);
}

#[test]
fn create_company_rejects_an_admin_not_registered_with_the_token() {
    let s = Setup::new();
    let admin = s.unregistered();
    let label = s.text("Acme");
    s.sign(
        &admin,
        "create_company",
        (&admin, COMPANY_AUDITOR, &label).into_val(&s.e),
    );

    let result = s
        .client()
        .try_create_company(&admin, &COMPANY_AUDITOR, &label);

    assert_eq!(result, Err(Ok(err(PayrollError::NotRegisteredWithToken))));
    assert!(s.payroll_events().events().is_empty());
    assert_eq!(s.client().company_count(), 0);
}

/// C9: a treasury registered under auditor id 2 cannot found a company that
/// names auditor id 1.
#[test]
fn create_company_rejects_an_auditor_id_other_than_the_registered_one() {
    let s = Setup::new();
    let admin = s.account(OTHER_AUDITOR);
    let label = s.text("Acme");
    s.sign(
        &admin,
        "create_company",
        (&admin, COMPANY_AUDITOR, &label).into_val(&s.e),
    );

    let result = s
        .client()
        .try_create_company(&admin, &COMPANY_AUDITOR, &label);

    assert_eq!(result, Err(Ok(err(PayrollError::AuditorMismatch))));
    assert!(s.payroll_events().events().is_empty());
    assert_eq!(s.client().company_count(), 0);
}

#[test]
fn create_company_rejects_empty_and_oversized_labels() {
    let s = Setup::new();
    let admin = s.account(COMPANY_AUDITOR);
    let empty = s.text("");
    let too_long = String::from_bytes(&s.e, &[b'x'; 65]);
    let longest = String::from_bytes(&s.e, &[b'x'; 64]);

    for label in [empty, too_long] {
        s.sign(
            &admin,
            "create_company",
            (&admin, COMPANY_AUDITOR, &label).into_val(&s.e),
        );
        let result = s
            .client()
            .try_create_company(&admin, &COMPANY_AUDITOR, &label);
        assert_eq!(result, Err(Ok(err(PayrollError::LabelInvalid))));
    }

    s.sign(
        &admin,
        "create_company",
        (&admin, COMPANY_AUDITOR, &longest).into_val(&s.e),
    );
    assert_eq!(
        s.client()
            .create_company(&admin, &COMPANY_AUDITOR, &longest),
        0
    );
}

/// C25, on-chain part: labels are kept byte for byte, with no parsing and no
/// rewriting, so the frontend receives exactly what the admin wrote and can
/// render it as plain text.
#[test]
fn labels_are_stored_and_emitted_byte_for_byte() {
    let s = Setup::new();
    let admin = s.account(COMPANY_AUDITOR);

    for (company_id, raw) in [
        (0u64, "=HYPERLINK(\"https://evil.example\",\"pay\")"),
        (1u64, "<img src=x onerror=alert(1)>"),
    ] {
        let label = s.text(raw);
        s.sign(
            &admin,
            "create_company",
            (&admin, COMPANY_AUDITOR, &label).into_val(&s.e),
        );
        s.client()
            .create_company(&admin, &COMPANY_AUDITOR, &label);

        assert_eq!(
            s.payroll_events(),
            std::vec![CompanyCreated {
                company_id,
                admin: admin.clone(),
                auditor_id: COMPANY_AUDITOR,
                label: label.clone(),
            }
            .to_xdr(&s.e, &s.payroll)]
        );
        assert_eq!(s.client().get_company(&company_id).label, label);
    }
}

#[test]
fn get_company_fails_for_an_unknown_id() {
    let s = Setup::new();

    assert_eq!(
        s.client().try_get_company(&5),
        Err(Ok(err(PayrollError::CompanyNotFound)))
    );
}

#[test]
fn reads_need_no_signature() {
    let s = Setup::new();
    let t = s.team(1);
    s.open_run(t.company_id, &t.admin, 7, 1);
    s.pay(t.company_id, 7, &t.admin, &s.items(&[&t.workers[0]]));
    let successor = s.account(COMPANY_AUDITOR);
    s.propose_admin(t.company_id, &t.admin, &successor, s.seq() + 10);

    // An empty list means every require_auth in the next calls would fail.
    s.e.mock_auths(&[]);
    let client = s.client();

    assert_eq!(client.get_company(&t.company_id).active_workers, 1);
    assert_eq!(client.get_run(&t.company_id, &7).status, RunStatus::Open);
    assert!(client.is_paid(&t.company_id, &7, &t.workers[0]));
    assert_eq!(
        client.worker_status(&t.company_id, &t.workers[0]),
        Some(WorkerStatus::Active)
    );
    assert_eq!(client.get_roster(&t.company_id, &0, &50).len(), 1);
    assert_eq!(
        client.pending_admin(&t.company_id).map(|p| p.new_admin),
        Some(successor)
    );
    assert_eq!(client.token(), s.token);
    assert_eq!(client.company_count(), 1);
    assert!(s.e.auths().is_empty());

    // The same empty list does block a write, so the reads above were not
    // passing on some leftover authorization.
    s.assert_auth_failed(client.try_close_run(&t.company_id, &7));
}

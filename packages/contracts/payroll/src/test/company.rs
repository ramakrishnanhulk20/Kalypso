//! The constructor, create_company with its token and registry checks, how a
//! token outage is reported, and the read-only functions.
//!
//! Not covered here: a real token registration (the mock reports whatever
//! auditor id the test chose; tests/attacks.rs runs the front-running case
//! against the real token wasm), and how a frontend renders or exports
//! labels, which is the off-chain half of C25. Wrong-signer cases are in
//! auth.rs.
extern crate std;

use soroban_sdk::{
    contract, contractimpl, panic_with_error, testutils::Address as _, Address, Env, Error,
    Event as _, IntoVal, String,
};

use super::registry::hand_over;
use super::{err, Setup, COMPANY_AUDITOR, OTHER_AUDITOR, WORKER_AUDITOR};
use crate::{Company, CompanyCreated, PayrollError, RunStatus, WorkerStatus};

/// Has `confidential_balance`, but every read fails with the token's
/// AuditorNotSet (3510), the way a misconfigured or broken token would.
#[contract]
pub struct FailingToken;

#[contractimpl]
impl FailingToken {
    pub fn confidential_balance(e: Env, _account: Address) -> u32 {
        panic_with_error!(&e, Error::from_contract_error(3510))
    }
}

/// Has `confidential_balance`, but answers with a number instead of an
/// account record.
#[contract]
pub struct GarbledToken;

#[contractimpl]
impl GarbledToken {
    pub fn confidential_balance(_e: Env, _account: Address) -> u32 {
        7
    }
}

#[test]
fn constructor_binds_the_token_and_starts_with_no_companies() {
    let s = Setup::new();

    assert_eq!(s.client().token(), s.token);
    assert_eq!(s.client().auditor_registry(), s.registry);
    assert_eq!(s.client().company_count(), 0);
}

#[test]
fn create_company_stores_the_company_and_emits_company_created() {
    let s = Setup::new();
    let admin = s.account(COMPANY_AUDITOR);
    let accountant = s.accountant(COMPANY_AUDITOR);
    let label = s.text("Acme");
    s.sign(
        &admin,
        "create_company",
        (&admin, &accountant, COMPANY_AUDITOR, &label).into_val(&s.e),
    );

    let company_id = s
        .client()
        .create_company(&admin, &accountant, &COMPANY_AUDITOR, &label);

    assert_eq!(
        s.payroll_events(),
        std::vec![CompanyCreated {
            company_id: 0,
            admin: admin.clone(),
            accountant: accountant.clone(),
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
            accountant,
            auditor_id: COMPANY_AUDITOR,
            label,
            created_ledger: 1_000,
            active_workers: 0,
            roster_len: 0,
            runs_opened: 0,
            admin_changes: 0,
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

    let result = s.try_create_company(&admin, &s.accountant(OTHER_AUDITOR), OTHER_AUDITOR, &label);

    assert_eq!(result, Err(Ok(err(PayrollError::CounterOverflow))));
    assert!(s.payroll_events().events().is_empty());
    assert_eq!(s.client().company_count(), u64::MAX);
    assert_eq!(
        s.client().try_get_company(&u64::MAX),
        Err(Ok(err(PayrollError::CompanyNotFound)))
    );
    assert_eq!(s.client().get_company(&0).admin, first);
}

/// The constructor writes the token and registry addresses and nothing
/// removes them. With either deleted straight from storage, every call that
/// needs it fails with MissingRecord rather than an unnamed trap.
#[test]
fn a_missing_token_or_registry_address_fails_with_missing_record() {
    for key in ["Token", "AuditorRegistry"] {
        let s = Setup::new();
        let admin = s.account(COMPANY_AUDITOR);
        let accountant = s.accountant(COMPANY_AUDITOR);
        s.e.as_contract(&s.payroll, || {
            s.e.storage().instance().remove(&s.key(key, ()));
        });

        let read = match key {
            "Token" => s.client().try_token(),
            _ => s.client().try_auditor_registry(),
        };
        assert_eq!(read, Err(Ok(err(PayrollError::MissingRecord))), "{key}");
        let label = s.text("Acme");
        assert_eq!(
            s.try_create_company(&admin, &accountant, COMPANY_AUDITOR, &label),
            Err(Ok(err(PayrollError::MissingRecord))),
            "{key}"
        );
        assert_eq!(s.client().company_count(), 0);
    }
}

#[test]
fn create_company_rejects_an_admin_not_registered_with_the_token() {
    let s = Setup::new();
    let admin = s.unregistered();
    let label = s.text("Acme");

    let result = s.try_create_company(&admin, &s.accountant(COMPANY_AUDITOR), COMPANY_AUDITOR, &label);

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

    let result = s.try_create_company(&admin, &s.accountant(COMPANY_AUDITOR), COMPANY_AUDITOR, &label);

    assert_eq!(result, Err(Ok(err(PayrollError::AuditorMismatch))));
    assert!(s.payroll_events().events().is_empty());
    assert_eq!(s.client().company_count(), 0);
}

/// C43: the named accountant must be the registry's owner of the company's
/// auditor id. With the admin correctly registered under that id, naming a
/// stranger, the owner of another id, or the admin itself is refused, and
/// nothing is stored or emitted.
#[test]
fn create_company_refuses_an_accountant_who_does_not_own_the_auditor_id() {
    let s = Setup::new();
    let admin = s.account(COMPANY_AUDITOR);
    let label = s.text("Acme");

    for accountant in [
        Address::generate(&s.e),
        s.accountant(OTHER_AUDITOR),
        admin.clone(),
    ] {
        assert_eq!(
            s.try_create_company(&admin, &accountant, COMPANY_AUDITOR, &label),
            Err(Ok(err(PayrollError::AuditorNotOwnedByAccountant)))
        );
        assert!(s.payroll_events().events().is_empty());
    }
    assert_eq!(s.client().company_count(), 0);
}

/// C43: the check reads who owns the id at the moment of creation. Once the
/// registry hands the id to a new owner, a new company must name the new
/// owner, naming the old one is refused, and the company created earlier
/// keeps the accountant it was created with.
#[test]
fn create_company_names_whoever_owns_the_auditor_id_at_creation() {
    let s = Setup::new();
    let admin = s.account(COMPANY_AUDITOR);
    let old_owner = s.accountant(COMPANY_AUDITOR);
    let first = s.create_company(&admin, COMPANY_AUDITOR, "Acme");
    let new_owner = Address::generate(&s.e);
    hand_over(&s.e, &s.registry, COMPANY_AUDITOR, &old_owner, &new_owner);
    let label = s.text("Acme Labs");

    assert_eq!(
        s.try_create_company(&admin, &old_owner, COMPANY_AUDITOR, &label),
        Err(Ok(err(PayrollError::AuditorNotOwnedByAccountant)))
    );
    assert_eq!(
        s.try_create_company(&admin, &new_owner, COMPANY_AUDITOR, &label),
        Ok(Ok(1))
    );
    assert_eq!(
        s.payroll_events(),
        std::vec![CompanyCreated {
            company_id: 1,
            admin: admin.clone(),
            accountant: new_owner.clone(),
            auditor_id: COMPANY_AUDITOR,
            label,
        }
        .to_xdr(&s.e, &s.payroll)]
    );
    assert_eq!(s.client().get_company(&1).accountant, new_owner);
    assert_eq!(s.client().get_company(&first).accountant, old_owner);
}

/// C43, failing closed: an id the registry never handed out has no owner,
/// so no accountant can be named for it, even though the mock token reports
/// the admin registered under it.
#[test]
fn create_company_refuses_an_auditor_id_the_registry_never_handed_out() {
    let s = Setup::new();
    let unknown = OTHER_AUDITOR + 1;
    let admin = s.account(unknown);
    let label = s.text("Acme");
    assert!(kalypso_auditor::AuditorRegistryClient::new(&s.e, &s.registry)
        .try_owner_of(&unknown)
        .is_err());

    for accountant in [Address::generate(&s.e), admin.clone()] {
        assert_eq!(
            s.try_create_company(&admin, &accountant, unknown, &label),
            Err(Ok(err(PayrollError::AuditorNotOwnedByAccountant)))
        );
    }
    assert_eq!(s.client().company_count(), 0);
}

/// C43, failing closed: a registry address that cannot answer `owner_of`,
/// because the contract there has no such function or there is no contract
/// at all, refuses the company rather than skipping the check.
#[test]
fn create_company_refuses_when_the_registry_cannot_be_read() {
    let s = Setup::new();
    let admin = s.account(COMPANY_AUDITOR);
    let accountant = s.accountant(COMPANY_AUDITOR);
    let label = s.text("Acme");

    for registry in [s.token.clone(), Address::generate(&s.e)] {
        let broken = s.rewired(&s.token, &registry);
        assert_eq!(
            broken.try_create_company(&admin, &accountant, COMPANY_AUDITOR, &label),
            Err(Ok(err(PayrollError::AuditorNotOwnedByAccountant)))
        );
        assert_eq!(broken.client().company_count(), 0);
    }
}

/// Every token read refuses on any failure, but only the token's own
/// AccountNotRegistered (3501) is reported as NotRegisteredWithToken. A token
/// with no `confidential_balance`, no contract at the address, a different
/// error, or an answer that is not an account is reported as
/// TokenUnavailable by all three calls that read a token account. The token
/// address is swapped straight in storage, because only the constructor can
/// set it, after the company, an invite and a proposal already exist.
#[test]
fn a_token_outage_is_reported_as_token_unavailable_and_only_3501_as_not_registered() {
    type BrokenToken = (&'static str, fn(&Setup) -> Address);
    let cases: [BrokenToken; 4] = [
        ("no confidential_balance", |s| s.registry.clone()),
        ("no contract", |s| Address::generate(&s.e)),
        ("another token error", |s| s.e.register(FailingToken, ())),
        ("an answer that is not an account", |s| {
            s.e.register(GarbledToken, ())
        }),
    ];
    for (case, broken_token) in cases {
        let s = Setup::new();
        let t = s.team(0);
        let worker = s.account(WORKER_AUDITOR);
        s.invite(t.company_id, &t.admin, &worker);
        let successor = s.account(COMPANY_AUDITOR);
        s.propose_admin(t.company_id, &t.admin, &successor, s.seq() + 10);
        let founder = s.account(OTHER_AUDITOR);
        let label = s.text("Beta");
        assert_eq!(
            s.try_create_company(&s.unregistered(), &s.accountant(OTHER_AUDITOR), OTHER_AUDITOR, &label),
            Err(Ok(err(PayrollError::NotRegisteredWithToken))),
            "{case}: the working token's 3501"
        );

        let broken = broken_token(&s);
        s.e.as_contract(&s.payroll, || crate::storage::set_token(&s.e, &broken));

        assert_eq!(
            s.try_create_company(&founder, &s.accountant(OTHER_AUDITOR), OTHER_AUDITOR, &label),
            Err(Ok(err(PayrollError::TokenUnavailable))),
            "{case}: create_company"
        );
        s.sign(&worker, "accept_invite", (t.company_id, &worker).into_val(&s.e));
        assert_eq!(
            s.client().try_accept_invite(&t.company_id, &worker),
            Err(Ok(err(PayrollError::TokenUnavailable))),
            "{case}: accept_invite"
        );
        s.sign(&successor, "accept_admin", (t.company_id,).into_val(&s.e));
        assert_eq!(
            s.client().try_accept_admin(&t.company_id),
            Err(Ok(err(PayrollError::TokenUnavailable))),
            "{case}: accept_admin"
        );
        assert_eq!(s.client().company_count(), 1);
        assert_eq!(
            s.client().worker_status(&t.company_id, &worker),
            Some(WorkerStatus::Invited)
        );
        assert_eq!(s.client().get_company(&t.company_id).admin, t.admin);
    }
}

#[test]
fn create_company_rejects_empty_and_oversized_labels() {
    let s = Setup::new();
    let admin = s.account(COMPANY_AUDITOR);
    let accountant = s.accountant(COMPANY_AUDITOR);
    let empty = s.text("");
    let too_long = String::from_bytes(&s.e, &[b'x'; 65]);
    let longest = String::from_bytes(&s.e, &[b'x'; 64]);

    for label in [empty, too_long] {
        let result = s.try_create_company(&admin, &accountant, COMPANY_AUDITOR, &label);
        assert_eq!(result, Err(Ok(err(PayrollError::LabelInvalid))));
    }

    assert_eq!(
        s.try_create_company(&admin, &accountant, COMPANY_AUDITOR, &longest),
        Ok(Ok(0))
    );
}

/// C25, on-chain part: labels are kept byte for byte, with no parsing and no
/// rewriting, so the frontend receives exactly what the admin wrote and can
/// render it as plain text.
#[test]
fn labels_are_stored_and_emitted_byte_for_byte() {
    let s = Setup::new();
    let admin = s.account(COMPANY_AUDITOR);
    let accountant = s.accountant(COMPANY_AUDITOR);

    for (company_id, raw) in [
        (0u64, "=HYPERLINK(\"https://evil.example\",\"pay\")"),
        (1u64, "<img src=x onerror=alert(1)>"),
    ] {
        let label = s.text(raw);
        s.sign(
            &admin,
            "create_company",
            (&admin, &accountant, COMPANY_AUDITOR, &label).into_val(&s.e),
        );
        s.client()
            .create_company(&admin, &accountant, &COMPANY_AUDITOR, &label);

        assert_eq!(
            s.payroll_events(),
            std::vec![CompanyCreated {
                company_id,
                admin: admin.clone(),
                accountant: accountant.clone(),
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
    assert_eq!(client.memberships_of(&t.workers[0]), 1);
    assert_eq!(
        client.pending_admin(&t.company_id).map(|p| p.new_admin),
        Some(successor)
    );
    assert_eq!(client.token(), s.token);
    assert_eq!(client.auditor_registry(), s.registry);
    assert_eq!(client.company_count(), 1);

    assert!(s.e.auths().is_empty());

    // The same empty list does block a write, so the reads above were not
    // passing on some leftover authorization.
    s.assert_auth_failed(client.try_close_run(&t.company_id, &7));
}

//! The exact topic and data layout of every payroll event, read back from
//! events the contract really emitted. Pinned because the event archive reads
//! company_id at topic index 1 as a u64.
//!
//! Not covered here: what each event means or when it fires, which the
//! per-function tests check by comparing whole events.
extern crate std;

use std::{format, string::String, vec, vec::Vec};

use soroban_sdk::{
    xdr::{ContractEventBody, ScVal},
    IntoVal,
};

use super::{Setup, COMPANY_AUDITOR, OTHER_AUDITOR, WORKER_AUDITOR};

/// The one event of the last call: its topics, written as the symbol for
/// topic 0, "u64 <value>" for numbers and "Address" for addresses, and the
/// field names of its data map in stored order.
fn layout(s: &Setup) -> (Vec<String>, Vec<String>) {
    let events = s.payroll_events();
    assert_eq!(events.events().len(), 1);
    let ContractEventBody::V0(body) = &events.events()[0].body;
    let topics = body
        .topics
        .iter()
        .map(|topic| match topic {
            ScVal::Symbol(symbol) => symbol.0.to_utf8_string_lossy(),
            ScVal::U64(value) => format!("u64 {value}"),
            ScVal::Address(_) => String::from("Address"),
            other => panic!("unexpected topic {other:?}"),
        })
        .collect();
    let data = match &body.data {
        ScVal::Map(Some(map)) => map
            .0
            .iter()
            .map(|entry| match &entry.key {
                ScVal::Symbol(symbol) => symbol.0.to_utf8_string_lossy(),
                other => panic!("unexpected data key {other:?}"),
            })
            .collect(),
        ScVal::Map(None) => vec![],
        other => panic!("data is not a map: {other:?}"),
    };
    (topics, data)
}

#[test]
fn every_event_has_its_name_then_the_company_id_as_a_u64() {
    let s = Setup::new();
    // A first company takes id 0, so the id under test is 1 and cannot be
    // mistaken for an empty or default value.
    s.create_company(&s.account(OTHER_AUDITOR), OTHER_AUDITOR, "Other");
    let admin = s.account(COMPANY_AUDITOR);
    let worker = s.account(WORKER_AUDITOR);
    let successor = s.account(COMPANY_AUDITOR);
    let expect = |topics: &[&str], data: &[&str]| {
        let (actual_topics, actual_data) = layout(&s);
        assert_eq!(actual_topics, topics);
        assert_eq!(actual_data, data);
    };

    let id = s.create_company(&admin, COMPANY_AUDITOR, "Acme");
    assert_eq!(id, 1);
    expect(&["company_created", "u64 1"], &["admin", "auditor_id", "label"]);
    s.invite(id, &admin, &worker);
    expect(&["worker_invited", "u64 1", "Address"], &[]);
    s.revoke(id, &admin, &worker);
    expect(&["invite_revoked", "u64 1", "Address"], &[]);
    s.invite(id, &admin, &worker);
    s.accept(id, &worker);
    expect(&["worker_joined", "u64 1", "Address"], &[]);
    s.open_run(id, &admin, 7, 1);
    expect(&["run_opened", "u64 1", "u64 7"], &["expected_count", "period_label"]);
    s.pay(id, 7, &admin, &s.items(&[&worker]));
    expect(&["payslip_issued", "u64 1", "u64 7", "Address"], &[]);
    s.close_run(id, &admin, 7);
    expect(&["run_closed", "u64 1", "u64 7"], &["paid_count"]);
    s.remove(id, &admin, &worker);
    expect(&["worker_removed", "u64 1", "Address"], &[]);
    s.propose_admin(id, &admin, &successor, s.seq() + 10);
    expect(&["admin_proposed", "u64 1"], &["live_until_ledger", "new_admin"]);
    s.sign(&admin, "cancel_admin_proposal", (id,).into_val(&s.e));
    s.client().cancel_admin_proposal(&id);
    expect(&["admin_proposal_cancelled", "u64 1"], &[]);
    s.propose_admin(id, &admin, &successor, s.seq() + 10);
    s.accept_admin(id, &successor);
    expect(&["admin_changed", "u64 1"], &["new_admin", "previous_admin"]);
}

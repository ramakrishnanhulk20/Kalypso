//! All state lives in instance or persistent storage, never temporary. A paid
//! flag in temporary storage would silently vanish after its lifetime and let
//! the same run pay the same worker again. Persistent entries are archived,
//! not deleted, when their lifetime runs out, so a flag is never read as
//! missing while it is archived.

use soroban_sdk::{contracttype, panic_with_error, Address, Env};

use crate::errors::PayrollError;
use crate::types::{Company, PendingAdmin, Run, WorkerStatus};

/// 86,400 seconds a day at about 5 seconds a ledger.
pub const DAY_IN_LEDGERS: u32 = 17_280;
/// About 30 days (518,400 ledgers) for the contract instance, extended on
/// every state-changing call.
pub const INSTANCE_EXTEND_TO: u32 = 30 * DAY_IN_LEDGERS;
/// Re-extend the instance only once it has less than about 29 days left, so a
/// busy day pays the extension once rather than on every call.
pub const INSTANCE_EXTEND_THRESHOLD: u32 = INSTANCE_EXTEND_TO - DAY_IN_LEDGERS;
/// About 180 days (3,110,400 ledgers) for every record, extended when written.
/// This is the network's maximum extension; the host clamps anything longer.
pub const RECORD_EXTEND_TO: u32 = 180 * DAY_IN_LEDGERS;
/// Skip the extension when a record was already extended within about a day.
pub const RECORD_EXTEND_THRESHOLD: u32 = RECORD_EXTEND_TO - DAY_IN_LEDGERS;

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Token,
    NextCompanyId,
    Company(u64),
    Worker(u64, Address),
    RosterAt(u64, u32),
    Run(u64, u64),
    Paid(u64, u64, Address),
    PendingAdmin(u64),
}

/// The value stored under `DataKey::Worker`. `on_roster` remembers that the
/// worker was already appended to the roster, so a worker who is removed,
/// invited again and accepts again is not appended a second time. Crate
/// visibility keeps this storage detail out of the published contract spec.
#[contracttype]
#[derive(Clone)]
pub(crate) struct WorkerRecord {
    pub(crate) status: WorkerStatus,
    pub(crate) on_roster: bool,
}

pub fn extend_instance(e: &Env) {
    e.storage()
        .instance()
        .extend_ttl(INSTANCE_EXTEND_THRESHOLD, INSTANCE_EXTEND_TO);
}

fn extend_record(e: &Env, key: &DataKey) {
    e.storage()
        .persistent()
        .extend_ttl(key, RECORD_EXTEND_THRESHOLD, RECORD_EXTEND_TO);
}

fn write_record<V: soroban_sdk::IntoVal<Env, soroban_sdk::Val>>(e: &Env, key: &DataKey, value: &V) {
    e.storage().persistent().set(key, value);
    extend_record(e, key);
}

/// A company that only ever pays, and a worker who is only ever paid, are
/// read by every run but rarely written, so state-changing calls extend the
/// records they read as well as the ones they write. The record must exist.
pub fn extend_company(e: &Env, company_id: u64) {
    extend_record(e, &DataKey::Company(company_id));
}

/// See `extend_company`. The record must exist.
pub fn extend_worker_record(e: &Env, company_id: u64, worker: &Address) {
    extend_record(e, &DataKey::Worker(company_id, worker.clone()));
}

pub fn set_token(e: &Env, token: &Address) {
    e.storage().instance().set(&DataKey::Token, token);
}

pub fn token(e: &Env) -> Address {
    // Set once by the constructor, which runs in the same transaction as the
    // deploy, so it is always present. If it ever is not, every call that
    // needs the token fails with a named error instead of a bare trap.
    e.storage()
        .instance()
        .get(&DataKey::Token)
        .unwrap_or_else(|| panic_with_error!(e, PayrollError::MissingRecord))
}

pub fn next_company_id(e: &Env) -> u64 {
    e.storage()
        .instance()
        .get(&DataKey::NextCompanyId)
        .unwrap_or(0)
}

pub fn set_next_company_id(e: &Env, next: u64) {
    e.storage().instance().set(&DataKey::NextCompanyId, &next);
}

pub fn company(e: &Env, company_id: u64) -> Option<Company> {
    e.storage().persistent().get(&DataKey::Company(company_id))
}

pub fn set_company(e: &Env, company_id: u64, company: &Company) {
    write_record(e, &DataKey::Company(company_id), company);
}

pub fn worker_record(e: &Env, company_id: u64, worker: &Address) -> Option<WorkerRecord> {
    e.storage()
        .persistent()
        .get(&DataKey::Worker(company_id, worker.clone()))
}

pub fn set_worker_record(e: &Env, company_id: u64, worker: &Address, record: &WorkerRecord) {
    write_record(e, &DataKey::Worker(company_id, worker.clone()), record);
}

pub fn roster_at(e: &Env, company_id: u64, index: u32) -> Option<Address> {
    e.storage()
        .persistent()
        .get(&DataKey::RosterAt(company_id, index))
}

pub fn set_roster_at(e: &Env, company_id: u64, index: u32, worker: &Address) {
    write_record(e, &DataKey::RosterAt(company_id, index), worker);
}

pub fn run(e: &Env, company_id: u64, run_id: u64) -> Option<Run> {
    e.storage().persistent().get(&DataKey::Run(company_id, run_id))
}

pub fn has_run(e: &Env, company_id: u64, run_id: u64) -> bool {
    e.storage().persistent().has(&DataKey::Run(company_id, run_id))
}

pub fn set_run(e: &Env, company_id: u64, run_id: u64, run: &Run) {
    write_record(e, &DataKey::Run(company_id, run_id), run);
}

pub fn is_paid(e: &Env, company_id: u64, run_id: u64, worker: &Address) -> bool {
    e.storage()
        .persistent()
        .has(&DataKey::Paid(company_id, run_id, worker.clone()))
}

pub fn set_paid(e: &Env, company_id: u64, run_id: u64, worker: &Address) {
    write_record(e, &DataKey::Paid(company_id, run_id, worker.clone()), &true);
}

pub fn pending_admin(e: &Env, company_id: u64) -> Option<PendingAdmin> {
    e.storage()
        .persistent()
        .get(&DataKey::PendingAdmin(company_id))
}

pub fn set_pending_admin(e: &Env, company_id: u64, pending: &PendingAdmin) {
    write_record(e, &DataKey::PendingAdmin(company_id), pending);
}

pub fn remove_pending_admin(e: &Env, company_id: u64) {
    e.storage()
        .persistent()
        .remove(&DataKey::PendingAdmin(company_id));
}

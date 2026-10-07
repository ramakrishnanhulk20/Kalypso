use soroban_sdk::{contracttype, panic_with_error, Address, Env};
use stellar_tokens::confidential::auditor::{
    AuditorStorageKey, AUDITOR_KEY_EXTEND_AMOUNT, AUDITOR_KEY_TTL_THRESHOLD,
};

use crate::errors::RegistryError;

// One ledger closes about every 5 seconds: 86,400 s / 5 s = 17,280 ledgers a day.
const DAY_IN_LEDGERS: u32 = 17_280;

// 30 days = 518,400 ledgers, topped up once fewer than 29 days (501,120 ledgers) remain.
pub const INSTANCE_EXTEND_AMOUNT: u32 = 30 * DAY_IN_LEDGERS;
pub const INSTANCE_TTL_THRESHOLD: u32 = INSTANCE_EXTEND_AMOUNT - DAY_IN_LEDGERS;

// Same 30 day window (518,400 ledgers) as OpenZeppelin uses for the key entry, so an owner record never archives before its key.
pub const OWNER_EXTEND_AMOUNT: u32 = AUDITOR_KEY_EXTEND_AMOUNT;
pub const OWNER_TTL_THRESHOLD: u32 = AUDITOR_KEY_TTL_THRESHOLD;

/// A handover the owner of an id has offered and the new owner has not yet
/// accepted.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingOwner {
    pub new_owner: Address,
    pub live_until_ledger: u32,
}

/// Storage keys owned by the registry. The key points themselves live under
/// OpenZeppelin's `AuditorStorageKey::Key(id)`, whose encoding (`["Key", id]`)
/// cannot collide with any variant here.
#[contracttype]
#[derive(Clone)]
pub enum RegistryStorageKey {
    /// Number of ids handed out so far, which is also the next id. Instance.
    KeyCount,
    /// The address that controls the key under an id. Persistent.
    Owner(u32),
    /// An offered, not yet accepted, handover of an id. Persistent, so the
    /// deadline check in `accept_owner` always decides expiry rather than the
    /// entry quietly disappearing.
    PendingOwner(u32),
}

pub fn key_count(e: &Env) -> u32 {
    e.storage()
        .instance()
        .get(&RegistryStorageKey::KeyCount)
        .unwrap_or(0)
}

pub fn set_key_count(e: &Env, count: u32) {
    e.storage()
        .instance()
        .set(&RegistryStorageKey::KeyCount, &count);
    extend_instance(e);
}

pub fn extend_instance(e: &Env) {
    e.storage()
        .instance()
        .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_EXTEND_AMOUNT);
}

/// OpenZeppelin's storage functions extend the key entry on read but not on
/// write, so every write path calls this.
pub fn extend_key(e: &Env, auditor_id: u32) {
    e.storage().persistent().extend_ttl(
        &AuditorStorageKey::Key(auditor_id),
        AUDITOR_KEY_TTL_THRESHOLD,
        AUDITOR_KEY_EXTEND_AMOUNT,
    );
}

/// Returns the owner of `auditor_id`, failing with
/// [`RegistryError::UnknownAuditor`] if the id was never handed out.
pub fn owner(e: &Env, auditor_id: u32) -> Address {
    e.storage()
        .persistent()
        .get(&RegistryStorageKey::Owner(auditor_id))
        .unwrap_or_else(|| panic_with_error!(e, RegistryError::UnknownAuditor))
}

pub fn set_owner(e: &Env, auditor_id: u32, owner: &Address) {
    e.storage()
        .persistent()
        .set(&RegistryStorageKey::Owner(auditor_id), owner);
    extend_owner(e, auditor_id);
}

pub fn extend_owner(e: &Env, auditor_id: u32) {
    e.storage().persistent().extend_ttl(
        &RegistryStorageKey::Owner(auditor_id),
        OWNER_TTL_THRESHOLD,
        OWNER_EXTEND_AMOUNT,
    );
}

pub fn pending_owner(e: &Env, auditor_id: u32) -> Option<PendingOwner> {
    e.storage()
        .persistent()
        .get(&RegistryStorageKey::PendingOwner(auditor_id))
}

/// The caller has already checked that the deadline is after the current
/// ledger and within the network's maximum entry lifetime.
pub fn set_pending_owner(e: &Env, auditor_id: u32, pending: &PendingOwner) {
    let key = RegistryStorageKey::PendingOwner(auditor_id);
    e.storage().persistent().set(&key, pending);
    // Keeps the record readable through its deadline, so a valid accept never
    // lands on an archived entry.
    let live_for = pending.live_until_ledger - e.ledger().sequence();
    e.storage()
        .persistent()
        .extend_ttl(&key, live_for, live_for);
}

pub fn remove_pending_owner(e: &Env, auditor_id: u32) {
    e.storage()
        .persistent()
        .remove(&RegistryStorageKey::PendingOwner(auditor_id));
}

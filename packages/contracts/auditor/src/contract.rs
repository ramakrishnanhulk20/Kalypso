use soroban_sdk::{contract, contractimpl, panic_with_error, Address, BytesN, Env};
use stellar_tokens::confidential::auditor as key_store;

use crate::{
    errors::RegistryError,
    events::{OwnerChanged, OwnerProposalCancelled, OwnerProposed, OwnerSet},
    storage::{self, PendingOwner},
};

/// Auditor key registry for the confidential token, with no admin. Each id
/// belongs to the address that registered it, and only that address (or
/// whoever it hands the id to) can ever change the key under it.
///
/// There is no constructor, no upgrade entry point and no stored privileged
/// address, so the deployer has exactly the same powers as any stranger.
#[contract]
pub struct AuditorRegistry;

#[contractimpl]
impl AuditorRegistry {
    /// Registers `point` as a new auditor key under the next free id and makes
    /// `owner` the only address that can change it. Ids are handed out in
    /// order (0, 1, 2, ...) and are never reused.
    ///
    /// Authorization: `owner`.
    ///
    /// Errors (both from OpenZeppelin's own point validation):
    /// * `AuditorError::IdentityPoint` (3302) if `point` is 64 zero bytes.
    /// * `AuditorError::PointNotOnCurve` (3303) if either coordinate is not
    ///   below the field modulus or the point is not on the Grumpkin curve.
    ///
    /// Events: `AuditorRegistered { auditor_id, point }` (OpenZeppelin), then
    /// [`OwnerSet`].
    ///
    /// Returns the new id.
    pub fn register_key(e: Env, owner: Address, point: BytesN<64>) -> u32 {
        owner.require_auth();

        let auditor_id = storage::key_count(&e);
        // Overflow-checks traps this increment at the u32 limit, and
        // OpenZeppelin's register_key refuses any id that already holds a key,
        // so an id can never be handed out twice.
        let next_count = auditor_id + 1;

        key_store::register_key(&e, auditor_id, &point);
        storage::extend_key(&e, auditor_id);
        storage::set_owner(&e, auditor_id, &owner);
        storage::set_key_count(&e, next_count);

        OwnerSet { auditor_id, owner }.publish(&e);
        auditor_id
    }

    /// Replaces the key under `auditor_id` with `new_point`. Proofs already
    /// built against the old key stop verifying, and only events after the
    /// rotation are encrypted to the new key.
    ///
    /// Authorization: the current owner of `auditor_id`.
    ///
    /// Errors:
    /// * [`RegistryError::UnknownAuditor`] (100) if the id was never handed out.
    /// * `AuditorError::IdentityPoint` (3302) or `AuditorError::PointNotOnCurve`
    ///   (3303) as for [`AuditorRegistry::register_key`].
    ///
    /// Events: `AuditorRotated { auditor_id, old_point, new_point }`
    /// (OpenZeppelin).
    pub fn rotate_key(e: Env, auditor_id: u32, new_point: BytesN<64>) {
        storage::owner(&e, auditor_id).require_auth();

        key_store::rotate_key(&e, auditor_id, &new_point);
        storage::extend_key(&e, auditor_id);
        storage::extend_owner(&e, auditor_id);
        storage::extend_instance(&e);
    }

    /// Offers `auditor_id` to `new_owner`, who can accept it up to and
    /// including ledger `live_until_ledger`. Proposing again replaces the
    /// earlier offer. The current owner keeps full control until the offer is
    /// accepted.
    ///
    /// Authorization: the current owner of `auditor_id`.
    ///
    /// Errors:
    /// * [`RegistryError::UnknownAuditor`] (100) if the id was never handed out.
    /// * [`RegistryError::SameOwner`] (104) if `new_owner` already owns the id.
    /// * [`RegistryError::InvalidLiveUntil`] (103) if `live_until_ledger` is
    ///   not after the current ledger, or is past the furthest ledger the
    ///   network lets a storage entry live to.
    ///
    /// Events: [`OwnerProposed`].
    pub fn propose_owner(e: Env, auditor_id: u32, new_owner: Address, live_until_ledger: u32) {
        let owner = storage::owner(&e, auditor_id);
        owner.require_auth();

        if new_owner == owner {
            panic_with_error!(&e, RegistryError::SameOwner);
        }
        // The upper bound guarantees the offer can be stored for its whole
        // window, so the deadline means what it says.
        if live_until_ledger <= e.ledger().sequence()
            || live_until_ledger > e.ledger().max_live_until_ledger()
        {
            panic_with_error!(&e, RegistryError::InvalidLiveUntil);
        }

        storage::set_pending_owner(
            &e,
            auditor_id,
            &PendingOwner {
                new_owner: new_owner.clone(),
                live_until_ledger,
            },
        );
        storage::extend_owner(&e, auditor_id);
        storage::extend_instance(&e);

        OwnerProposed {
            auditor_id,
            new_owner,
            live_until_ledger,
        }
        .publish(&e);
    }

    /// Withdraws the pending handover of `auditor_id`, expired or not.
    ///
    /// Authorization: the current owner of `auditor_id`.
    ///
    /// Errors:
    /// * [`RegistryError::UnknownAuditor`] (100) if the id was never handed out.
    /// * [`RegistryError::NoPendingOwner`] (101) if no handover is pending.
    ///
    /// Events: [`OwnerProposalCancelled`].
    pub fn cancel_owner_proposal(e: Env, auditor_id: u32) {
        storage::owner(&e, auditor_id).require_auth();

        if storage::pending_owner(&e, auditor_id).is_none() {
            panic_with_error!(&e, RegistryError::NoPendingOwner);
        }

        storage::remove_pending_owner(&e, auditor_id);
        storage::extend_owner(&e, auditor_id);
        storage::extend_instance(&e);

        OwnerProposalCancelled { auditor_id }.publish(&e);
    }

    /// Completes a handover: the proposed address becomes the owner of
    /// `auditor_id` and the previous owner loses all control over it.
    ///
    /// Authorization: the proposed new owner, on or before the offer's
    /// `live_until_ledger`.
    ///
    /// Errors:
    /// * [`RegistryError::UnknownAuditor`] (100) if the id was never handed out.
    /// * [`RegistryError::NoPendingOwner`] (101) if no handover is pending.
    /// * [`RegistryError::OwnerTransferExpired`] (102) if the current ledger is
    ///   after `live_until_ledger`.
    ///
    /// Events: [`OwnerChanged`].
    pub fn accept_owner(e: Env, auditor_id: u32) {
        let previous_owner = storage::owner(&e, auditor_id);
        let pending = storage::pending_owner(&e, auditor_id)
            .unwrap_or_else(|| panic_with_error!(&e, RegistryError::NoPendingOwner));
        if e.ledger().sequence() > pending.live_until_ledger {
            panic_with_error!(&e, RegistryError::OwnerTransferExpired);
        }
        pending.new_owner.require_auth();

        storage::remove_pending_owner(&e, auditor_id);
        storage::set_owner(&e, auditor_id, &pending.new_owner);
        storage::extend_instance(&e);

        OwnerChanged {
            auditor_id,
            previous_owner,
            new_owner: pending.new_owner,
        }
        .publish(&e);
    }

    /// Returns the key registered or last rotated under `auditor_id`. This is
    /// the only registry function the confidential token calls, inside its own
    /// transactions, so it also extends the lifetime of the key, its owner
    /// record and the contract instance: a key in use never archives.
    ///
    /// Authorization: none.
    ///
    /// Errors:
    /// * `AuditorError::AuditorNotRegistered` (3301) if the id was never
    ///   handed out. This is OpenZeppelin's own error, so the token's
    ///   `register` fails with the code its documentation names.
    ///
    /// Events: none.
    pub fn get_key(e: Env, auditor_id: u32) -> BytesN<64> {
        let point = key_store::get_key(&e, auditor_id);
        storage::extend_owner(&e, auditor_id);
        storage::extend_instance(&e);
        point
    }

    /// Returns the address that controls `auditor_id`.
    ///
    /// Authorization: none.
    ///
    /// Errors:
    /// * [`RegistryError::UnknownAuditor`] (100) if the id was never handed out.
    ///
    /// Events: none.
    pub fn owner_of(e: Env, auditor_id: u32) -> Address {
        storage::owner(&e, auditor_id)
    }

    /// Returns the pending handover of `auditor_id`, if any. The offer is
    /// returned as stored, so callers compare `live_until_ledger` with the
    /// current ledger to tell whether it can still be accepted.
    ///
    /// Authorization: none.
    ///
    /// Errors:
    /// * [`RegistryError::UnknownAuditor`] (100) if the id was never handed out,
    ///   so "no such auditor" never reads as "no handover pending".
    ///
    /// Events: none.
    pub fn pending_owner(e: Env, auditor_id: u32) -> Option<PendingOwner> {
        storage::owner(&e, auditor_id);
        storage::pending_owner(&e, auditor_id)
    }

    /// Returns how many ids have been handed out. Valid ids are exactly
    /// `0..key_count`.
    ///
    /// Authorization: none.
    ///
    /// Errors: none.
    ///
    /// Events: none.
    pub fn key_count(e: Env) -> u32 {
        storage::key_count(&e)
    }
}

//! Ownership events. Key registration and rotation events come from
//! OpenZeppelin's storage functions (`AuditorRegistered`, `AuditorRotated`),
//! so the registry does not emit a second copy of them.

use soroban_sdk::{contractevent, Address};

/// `register_key` gave a fresh id to the address that signed for it.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OwnerSet {
    #[topic]
    pub auditor_id: u32,
    #[topic]
    pub owner: Address,
}

/// The owner of an id offered it to `new_owner` until `live_until_ledger`.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OwnerProposed {
    #[topic]
    pub auditor_id: u32,
    pub new_owner: Address,
    pub live_until_ledger: u32,
}

/// The owner of an id withdrew a pending handover.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OwnerProposalCancelled {
    #[topic]
    pub auditor_id: u32,
}

/// The proposed address accepted the id. From this point only `new_owner`
/// can rotate the key or hand the id on.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OwnerChanged {
    #[topic]
    pub auditor_id: u32,
    pub previous_owner: Address,
    pub new_owner: Address,
}

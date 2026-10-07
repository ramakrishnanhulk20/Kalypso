#![no_std]
//! Kalypso auditor registry. The confidential token reads each account's
//! auditor key from here with `get_key(auditor_id)`. Each id belongs to the
//! accountant who registered it; nobody else, including the deployer, can
//! register over it, rotate it or hand it on. Key validation and key storage
//! are OpenZeppelin's own code at stellar-contracts commit 98090b3.

mod contract;
mod errors;
mod events;
mod storage;

#[cfg(test)]
mod test;

pub use contract::{AuditorRegistry, AuditorRegistryClient};
pub use errors::RegistryError;
pub use events::{OwnerChanged, OwnerProposalCancelled, OwnerProposed, OwnerSet};
pub use storage::PendingOwner;

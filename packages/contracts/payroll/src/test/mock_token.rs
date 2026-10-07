//! A stand-in for the confidential token. It checks the sender's signature
//! the way the real token does, refuses unregistered recipients and accounts
//! with the real token's error 3501, and records every transfer it accepts.
//! The unit tests use it as a module, and tests/props.rs includes this file by
//! path, so it refers only to soroban_sdk and never to the payroll crate.
//!
//! Not covered here: proofs, encrypted balances, the auditor registry, the
//! sender's registration, and every other check the real token makes. M2c
//! integration and fork tests run payroll against the real token wasm.

use soroban_sdk::{
    contract, contractimpl, contracttype, panic_with_error, Address, Bytes, BytesN, Env, Vec,
};

/// The real token's account record and errors, generated from the same
/// pinned wasm the payroll crate imports. Only `ConfidentialAccount` and
/// `ConfidentialTokenError` are used; the rest of the generated interface is
/// not, which is why dead code is allowed here.
#[allow(dead_code)]
pub mod deployed_token {
    pub type Point = soroban_sdk::BytesN<64>;

    soroban_sdk::contractimport!(
        file = "../fixtures/confidential_token.wasm",
        sha256 = "c77ac818ab3af1a2b9cdbc54964d68070f106fb72c9172ba4fff186995704cfd"
    );
}

use deployed_token::{ConfidentialAccount, ConfidentialTokenError};

#[contracttype]
#[derive(Clone)]
enum MockKey {
    Registered(Address),
    Transfers,
}

/// One transfer the mock accepted.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecordedTransfer {
    pub from: Address,
    pub to: Address,
    pub data: Bytes,
}

#[contract]
pub struct MockToken;

#[contractimpl]
impl MockToken {
    pub fn confidential_transfer(e: Env, from: Address, to: Address, data: Bytes) {
        from.require_auth();
        if !e.storage().instance().has(&MockKey::Registered(to.clone())) {
            panic_with_error!(&e, ConfidentialTokenError::AccountNotRegistered);
        }
        let mut transfers = Self::transfers(e.clone());
        transfers.push_back(RecordedTransfer { from, to, data });
        e.storage().instance().set(&MockKey::Transfers, &transfers);
    }

    pub fn confidential_balance(e: Env, account: Address) -> ConfidentialAccount {
        let auditor_id: u32 = e
            .storage()
            .instance()
            .get(&MockKey::Registered(account))
            .unwrap_or_else(|| panic_with_error!(&e, ConfidentialTokenError::AccountNotRegistered));
        let identity = BytesN::from_array(&e, &[0u8; 64]);
        ConfidentialAccount {
            auditor_id,
            receiving_commitment: identity.clone(),
            spendable_commitment: identity.clone(),
            spending_public_key: identity.clone(),
            viewing_public_key: identity,
        }
    }

    /// Test control, not a token entry point: marks `account` as registered
    /// under `auditor_id`. The real token needs the account's signature and a
    /// proof for this.
    pub fn register(e: Env, account: Address, auditor_id: u32) {
        e.storage()
            .instance()
            .set(&MockKey::Registered(account), &auditor_id);
    }

    /// Every transfer accepted so far, in call order.
    pub fn transfers(e: Env) -> Vec<RecordedTransfer> {
        e.storage()
            .instance()
            .get(&MockKey::Transfers)
            .unwrap_or(Vec::new(&e))
    }
}

/// Registers `account` with the mock token under `auditor_id`.
pub fn register_account(e: &Env, token: &Address, account: &Address, auditor_id: u32) {
    MockTokenClient::new(e, token).register(account, &auditor_id);
}

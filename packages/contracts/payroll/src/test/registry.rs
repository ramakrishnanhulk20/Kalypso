//! The real kalypso-auditor registry, set up for payroll tests. The unit
//! tests use this as a module, and tests/props.rs and tests/attacks.rs
//! include it by path, so it refers only to soroban_sdk and kalypso_auditor
//! and never to the payroll crate.
//!
//! Not covered here: the keys themselves. The payroll only asks the registry
//! who owns an id, so every id gets the same valid curve point.

use kalypso_auditor::{AuditorRegistry, AuditorRegistryClient};
use soroban_sdk::{
    testutils::{MockAuth, MockAuthInvoke},
    Address, BytesN, Env, IntoVal,
};

/// Barretenberg's Grumpkin generator G, from stellar-contract-utils
/// crypto/grumpkin.rs at 98090b3. On the curve by definition, so both the
/// registry and the real token accept it.
pub const GENERATOR: [u8; 64] = [
    0x08, 0x3e, 0x79, 0x11, 0xd8, 0x35, 0x09, 0x76, 0x29, 0xf0, 0x06, 0x75, 0x31, 0xfc, 0x15, 0xca,
    0xfd, 0x79, 0xa8, 0x9b, 0xee, 0xcb, 0x39, 0x90, 0x3f, 0x69, 0x57, 0x2c, 0x63, 0x6f, 0x4a, 0x5a,
    0x1a, 0x7f, 0x5e, 0xfa, 0xad, 0x7f, 0x31, 0x5c, 0x25, 0xa9, 0x18, 0xf3, 0x0c, 0xc8, 0xd7, 0x33,
    0x3f, 0xcc, 0xab, 0x7a, 0xd7, 0xc9, 0x0f, 0x14, 0xde, 0x81, 0xbc, 0xc5, 0x28, 0xf9, 0x93, 0x5d,
];

pub fn deploy_registry(e: &Env) -> Address {
    e.register(AuditorRegistry, ())
}

/// Registers a key under the registry's next id, signed by `owner` alone,
/// and returns the id. Replaces any earlier mocked authorization.
pub fn register_auditor(e: &Env, registry: &Address, owner: &Address) -> u32 {
    let key = BytesN::from_array(e, &GENERATOR);
    e.mock_auths(&[MockAuth {
        address: owner,
        invoke: &MockAuthInvoke {
            contract: registry,
            fn_name: "register_key",
            args: (owner, &key).into_val(e),
            sub_invokes: &[],
        },
    }]);
    AuditorRegistryClient::new(e, registry).register_key(owner, &key)
}

/// Registers ids 0 to `last_id`, each owned by a fresh accountant, so the
/// fixed ids a test names exist with an owner. Ids are handed out in order,
/// so this is the only way to reach a chosen id.
pub fn register_auditors_through(e: &Env, registry: &Address, last_id: u32) {
    use soroban_sdk::testutils::Address as _;
    for _ in 0..=last_id {
        register_auditor(e, registry, &Address::generate(e));
    }
}

pub fn owner_of(e: &Env, registry: &Address, auditor_id: u32) -> Address {
    AuditorRegistryClient::new(e, registry).owner_of(&auditor_id)
}

/// Moves `auditor_id` from `from` to `to` through the registry's own
/// two-step handover, each step signed by its one signer.
pub fn hand_over(e: &Env, registry: &Address, auditor_id: u32, from: &Address, to: &Address) {
    let client = AuditorRegistryClient::new(e, registry);
    let live_until = e.ledger().sequence() + 10;
    e.mock_auths(&[MockAuth {
        address: from,
        invoke: &MockAuthInvoke {
            contract: registry,
            fn_name: "propose_owner",
            args: (auditor_id, to, live_until).into_val(e),
            sub_invokes: &[],
        },
    }]);
    client.propose_owner(&auditor_id, to, &live_until);
    e.mock_auths(&[MockAuth {
        address: to,
        invoke: &MockAuthInvoke {
            contract: registry,
            fn_name: "accept_owner",
            args: (auditor_id,).into_val(e),
            sub_invokes: &[],
        },
    }]);
    client.accept_owner(&auditor_id);
}

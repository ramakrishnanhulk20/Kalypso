//! Unit tests for every registry function. Each signed call is authorized for
//! one named signer with `mock_auths`, never `mock_all_auths`, so a call by the
//! wrong address really fails the signature check.
//!
//! Not covered here: random call sequences (tests/props.rs), the real
//! confidential token reading keys (tests/token_integration.rs), the compiled
//! wasm and its exported interface, testnet behaviour, and the correctness of
//! OpenZeppelin's Grumpkin validator beyond the boundary cases below.

extern crate std;

use soroban_sdk::{
    testutils::{
        storage::{Instance as _, Persistent as _, Temporary as _},
        Address as _, EnvTestConfig, Events as _, Ledger as _, MockAuth, MockAuthInvoke,
    },
    xdr::{ScErrorCode, ScErrorType},
    Address, BytesN, Env, Error, Event as _, IntoVal, InvokeError, Map, Val, Vec,
};
use stellar_tokens::confidential::auditor::{
    AuditorError, AuditorRegistered, AuditorRotated, AuditorStorageKey, AUDITOR_KEY_EXTEND_AMOUNT,
};

use crate::{
    contract::{AuditorRegistry, AuditorRegistryClient},
    errors::RegistryError,
    events::{OwnerChanged, OwnerProposalCancelled, OwnerProposed, OwnerSet},
    storage::{
        PendingOwner, RegistryStorageKey, INSTANCE_EXTEND_AMOUNT, OWNER_EXTEND_AMOUNT,
        OWNER_TTL_THRESHOLD,
    },
};

// Grumpkin generator G = (1, y), the fixture OpenZeppelin's own auditor tests use.
const G: (&str, &str) = (
    "0000000000000000000000000000000000000000000000000000000000000001",
    "0000000000000002cf135e7506a45d632d270d45f1181294833fc48d823f272c",
);
// Y = 0xdead * H, from circuits/lib/testdata/scalar_mul.json at 98090b3.
const DEAD_H: (&str, &str) = (
    "1b46b003b88a6c34549dc74115f088f4b231a151397526bc10cbf1d15b457646",
    "29116280600c10ead1fdbd9ab4b571896030679bf554d7f1ebf681e5147de21b",
);
// PVK = vk * H, from circuits/lib/testdata/pvk_from_vk.json at 98090b3.
const PVK: (&str, &str) = (
    "2e7421c0e86a4c8eed823edf851c364ecee448bf70eae2a95befe3dd9364cc45",
    "0b060655740aabef84e7305bb886b75da8d258f346381f03925d69645292fe7a",
);
// 1000 * G + 42 * H, from circuits/lib/testdata/commit.json at 98090b3.
const COMMIT: (&str, &str) = (
    "195a5d8ecd032fe1696054b28f0852b5f03a613681991ace823245ab2f97ed05",
    "0e67489ecfee0e581dce7db22a383c635886cfb616c3b3bb033bff0c46e9789e",
);
// The field modulus r: the smallest 32-byte value that is not a canonical coordinate.
const MODULUS: &str = "30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001";
// 1 + r reduces to 1, so (1 + r, G.y) is G under a second encoding that only a canonical check catches.
const MODULUS_PLUS_ONE: &str = "30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000002";
const ZERO: &str = "0000000000000000000000000000000000000000000000000000000000000000";
const TWO: &str = "0000000000000000000000000000000000000000000000000000000000000002";

const DAY: u32 = 17_280;

fn point(e: &Env, (x, y): (&str, &str)) -> BytesN<64> {
    let hex = [x, y].concat();
    assert_eq!(hex.len(), 128);
    let mut bytes = [0u8; 64];
    for (i, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).unwrap();
    }
    BytesN::from_array(e, &bytes)
}

fn setup<'a>() -> (Env, AuditorRegistryClient<'a>) {
    // Snapshot files would land outside src/ and tests/.
    let e = Env::new_with_config(EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    let id = e.register(AuditorRegistry, ());
    let client = AuditorRegistryClient::new(&e, &id);
    (e, client)
}

/// Authorizes exactly one call, by exactly one signer, replacing any earlier
/// authorization.
fn sign(c: &AuditorRegistryClient, signer: &Address, fn_name: &str, args: Vec<Val>) {
    c.env.mock_auths(&[MockAuth {
        address: signer,
        invoke: &MockAuthInvoke {
            contract: &c.address,
            fn_name,
            args,
            sub_invokes: &[],
        },
    }]);
}

fn register(c: &AuditorRegistryClient, owner: &Address, key: &BytesN<64>) -> u32 {
    sign(
        c,
        owner,
        "register_key",
        (owner.clone(), key.clone()).into_val(&c.env),
    );
    c.register_key(owner, key)
}

type Outcome<T> = Result<Result<T, soroban_sdk::ConversionError>, Result<Error, InvokeError>>;

fn try_register(
    c: &AuditorRegistryClient,
    signer: &Address,
    owner: &Address,
    key: &BytesN<64>,
) -> Outcome<u32> {
    sign(
        c,
        signer,
        "register_key",
        (owner.clone(), key.clone()).into_val(&c.env),
    );
    c.try_register_key(owner, key)
}

fn rotate(c: &AuditorRegistryClient, signer: &Address, id: u32, key: &BytesN<64>) -> Outcome<()> {
    sign(c, signer, "rotate_key", (id, key.clone()).into_val(&c.env));
    c.try_rotate_key(&id, key)
}

fn propose(
    c: &AuditorRegistryClient,
    signer: &Address,
    id: u32,
    to: &Address,
    until: u32,
) -> Outcome<()> {
    sign(
        c,
        signer,
        "propose_owner",
        (id, to.clone(), until).into_val(&c.env),
    );
    c.try_propose_owner(&id, to, &until)
}

fn cancel(c: &AuditorRegistryClient, signer: &Address, id: u32) -> Outcome<()> {
    sign(c, signer, "cancel_owner_proposal", (id,).into_val(&c.env));
    c.try_cancel_owner_proposal(&id)
}

fn accept(c: &AuditorRegistryClient, signer: &Address, id: u32) -> Outcome<()> {
    sign(c, signer, "accept_owner", (id,).into_val(&c.env));
    c.try_accept_owner(&id)
}

fn failure<T>(outcome: Outcome<T>) -> Error {
    match outcome {
        Err(Ok(error)) => error,
        Err(Err(invoke)) => panic!("call aborted without an error code: {invoke:?}"),
        Ok(_) => panic!("call succeeded but was expected to fail"),
    }
}

/// What a `try_` call reports when the host refuses a signature. The host's
/// try_call narrows every non-contract failure to this one code, so each use
/// below is paired with the same call succeeding for the right signer, and
/// `wrong_signer_fails_the_auth_check` shows the error underneath.
fn refused() -> Error {
    Error::from_type_and_code(ScErrorType::Context, ScErrorCode::InvalidAction)
}

fn set_ledger(e: &Env, sequence: u32) {
    e.ledger().set_sequence_number(sequence);
}

#[test]
fn register_hands_out_ids_in_order() {
    let (e, c) = setup();
    let owners = [
        Address::generate(&e),
        Address::generate(&e),
        Address::generate(&e),
    ];
    let keys = [point(&e, G), point(&e, DEAD_H), point(&e, PVK)];
    assert_eq!(c.key_count(), 0);

    for (expected_id, (owner, key)) in owners.iter().zip(keys.iter()).enumerate() {
        assert_eq!(register(&c, owner, key), expected_id as u32);
    }

    assert_eq!(c.key_count(), 3);
    for (id, (owner, key)) in owners.iter().zip(keys.iter()).enumerate() {
        assert_eq!(c.get_key(&(id as u32)), *key);
        assert_eq!(c.owner_of(&(id as u32)), *owner);
        assert_eq!(c.pending_owner(&(id as u32)), None);
    }
}

#[test]
fn register_emits_key_and_owner_events() {
    let (e, c) = setup();
    let owner = Address::generate(&e);
    let key = point(&e, G);

    register(&c, &owner, &key);

    assert_eq!(
        e.events().all(),
        std::vec![
            AuditorRegistered {
                auditor_id: 0,
                point: key
            }
            .to_xdr(&e, &c.address),
            OwnerSet {
                auditor_id: 0,
                owner
            }
            .to_xdr(&e, &c.address),
        ]
    );
}

#[test]
fn register_needs_the_named_owners_signature() {
    let (e, c) = setup();
    let victim = Address::generate(&e);
    let attacker = Address::generate(&e);

    let outcome = try_register(&c, &attacker, &victim, &point(&e, G));

    assert_eq!(failure(outcome), refused());
    assert_eq!(c.key_count(), 0);
    assert_eq!(
        failure(c.try_owner_of(&0)),
        RegistryError::UnknownAuditor.into()
    );
    assert_eq!(try_register(&c, &victim, &victim, &point(&e, G)), Ok(Ok(0)));
}

#[test]
#[should_panic(expected = "Error(Auth, InvalidAction)")]
fn wrong_signer_fails_the_auth_check() {
    let (e, c) = setup();
    let owner = Address::generate(&e);
    let attacker = Address::generate(&e);
    let id = register(&c, &owner, &point(&e, G));
    let key = point(&e, DEAD_H);

    sign(&c, &attacker, "rotate_key", (id, key.clone()).into_val(&e));
    c.rotate_key(&id, &key);
}

#[test]
fn register_rejects_identity_point() {
    let (e, c) = setup();
    let owner = Address::generate(&e);

    let outcome = try_register(&c, &owner, &owner, &point(&e, (ZERO, ZERO)));

    assert_eq!(failure(outcome), AuditorError::IdentityPoint.into());
    assert_eq!(c.key_count(), 0);
}

#[test]
fn register_rejects_off_curve_point() {
    let (e, c) = setup();
    let owner = Address::generate(&e);
    let one = G.0;

    // (1, 2) is canonical, but 2^2 is not 1^3 - 17 mod r.
    let outcome = try_register(&c, &owner, &owner, &point(&e, (one, TWO)));

    assert_eq!(failure(outcome), AuditorError::PointNotOnCurve.into());
    assert_eq!(c.key_count(), 0);
}

#[test]
fn register_rejects_x_equal_to_the_modulus() {
    let (e, c) = setup();
    let owner = Address::generate(&e);

    let outcome = try_register(&c, &owner, &owner, &point(&e, (MODULUS, G.1)));

    assert_eq!(failure(outcome), AuditorError::PointNotOnCurve.into());
    assert_eq!(c.key_count(), 0);
}

#[test]
fn register_rejects_a_second_encoding_of_a_valid_point() {
    let (e, c) = setup();
    let owner = Address::generate(&e);

    let outcome = try_register(&c, &owner, &owner, &point(&e, (MODULUS_PLUS_ONE, G.1)));

    assert_eq!(failure(outcome), AuditorError::PointNotOnCurve.into());
    assert_eq!(c.key_count(), 0);
}

#[test]
fn register_accepts_valid_grumpkin_points() {
    let (e, c) = setup();
    let owner = Address::generate(&e);

    for (id, fixture) in [G, DEAD_H, PVK, COMMIT].into_iter().enumerate() {
        let key = point(&e, fixture);
        assert_eq!(register(&c, &owner, &key), id as u32);
        assert_eq!(c.get_key(&(id as u32)), key);
    }
}

#[test]
fn rotate_rejects_invalid_points_and_keeps_the_old_key() {
    let (e, c) = setup();
    let owner = Address::generate(&e);
    let key = point(&e, G);
    let id = register(&c, &owner, &key);

    let identity = rotate(&c, &owner, id, &point(&e, (ZERO, ZERO)));
    let off_curve = rotate(&c, &owner, id, &point(&e, (G.0, TWO)));
    let alias = rotate(&c, &owner, id, &point(&e, (MODULUS_PLUS_ONE, G.1)));

    assert_eq!(failure(identity), AuditorError::IdentityPoint.into());
    assert_eq!(failure(off_curve), AuditorError::PointNotOnCurve.into());
    assert_eq!(failure(alias), AuditorError::PointNotOnCurve.into());
    assert_eq!(c.get_key(&id), key);
}

#[test]
fn owner_rotates_key() {
    let (e, c) = setup();
    let owner = Address::generate(&e);
    let old_point = point(&e, G);
    let new_point = point(&e, DEAD_H);
    let id = register(&c, &owner, &old_point);

    assert_eq!(rotate(&c, &owner, id, &new_point), Ok(Ok(())));

    assert_eq!(
        e.events().all(),
        std::vec![AuditorRotated {
            auditor_id: id,
            old_point,
            new_point: new_point.clone()
        }
        .to_xdr(&e, &c.address)]
    );
    assert_eq!(c.get_key(&id), new_point);
    assert_eq!(c.owner_of(&id), owner);
}

#[test]
fn rotate_by_anyone_but_the_owner_fails() {
    let (e, c) = setup();
    let owner = Address::generate(&e);
    let attacker = Address::generate(&e);
    // The registry stores no deployer, so the address that deployed it is just another stranger.
    let deployer = Address::generate(&e);
    let proposed = Address::generate(&e);
    let key = point(&e, G);
    let id = register(&c, &owner, &key);
    propose(&c, &owner, id, &proposed, 100).unwrap().unwrap();

    for stranger in [&attacker, &deployer, &proposed] {
        let outcome = rotate(&c, stranger, id, &point(&e, DEAD_H));
        assert_eq!(failure(outcome), refused());
    }
    assert_eq!(c.get_key(&id), key);
    assert_eq!(rotate(&c, &owner, id, &point(&e, DEAD_H)), Ok(Ok(())));
}

#[test]
fn rotate_unknown_id_fails() {
    let (e, c) = setup();
    let someone = Address::generate(&e);

    let outcome = rotate(&c, &someone, 0, &point(&e, G));

    assert_eq!(failure(outcome), RegistryError::UnknownAuditor.into());
}

#[test]
fn propose_records_the_offer() {
    let (e, c) = setup();
    let owner = Address::generate(&e);
    let new_owner = Address::generate(&e);
    let id = register(&c, &owner, &point(&e, G));

    assert_eq!(propose(&c, &owner, id, &new_owner, 50), Ok(Ok(())));

    assert_eq!(
        e.events().all(),
        std::vec![OwnerProposed {
            auditor_id: id,
            new_owner: new_owner.clone(),
            live_until_ledger: 50
        }
        .to_xdr(&e, &c.address)]
    );
    assert_eq!(
        c.pending_owner(&id),
        Some(PendingOwner {
            new_owner,
            live_until_ledger: 50
        })
    );
    assert_eq!(c.owner_of(&id), owner);
}

#[test]
fn propose_by_anyone_but_the_owner_fails() {
    let (e, c) = setup();
    let owner = Address::generate(&e);
    let attacker = Address::generate(&e);
    let id = register(&c, &owner, &point(&e, G));

    let outcome = propose(&c, &attacker, id, &attacker, 50);

    assert_eq!(failure(outcome), refused());
    assert_eq!(c.pending_owner(&id), None);
    assert_eq!(propose(&c, &owner, id, &attacker, 50), Ok(Ok(())));
}

#[test]
fn propose_to_the_current_owner_fails() {
    let (e, c) = setup();
    let owner = Address::generate(&e);
    let id = register(&c, &owner, &point(&e, G));

    let outcome = propose(&c, &owner, id, &owner, 50);

    assert_eq!(failure(outcome), RegistryError::SameOwner.into());
}

#[test]
fn propose_rejects_a_deadline_not_after_the_current_ledger() {
    let (e, c) = setup();
    let owner = Address::generate(&e);
    let new_owner = Address::generate(&e);
    let id = register(&c, &owner, &point(&e, G));
    set_ledger(&e, 100);

    for deadline in [0, 99, 100] {
        let outcome = propose(&c, &owner, id, &new_owner, deadline);
        assert_eq!(failure(outcome), RegistryError::InvalidLiveUntil.into());
    }
    assert_eq!(c.pending_owner(&id), None);
}

#[test]
fn propose_rejects_a_deadline_past_the_longest_entry_lifetime() {
    let (e, c) = setup();
    let owner = Address::generate(&e);
    let new_owner = Address::generate(&e);
    let id = register(&c, &owner, &point(&e, G));
    let furthest = e.ledger().max_live_until_ledger();

    let too_far = propose(&c, &owner, id, &new_owner, furthest + 1);
    let at_limit = propose(&c, &owner, id, &new_owner, furthest);

    assert_eq!(failure(too_far), RegistryError::InvalidLiveUntil.into());
    assert_eq!(at_limit, Ok(Ok(())));
}

#[test]
fn propose_again_replaces_the_earlier_offer() {
    let (e, c) = setup();
    let owner = Address::generate(&e);
    let first = Address::generate(&e);
    let second = Address::generate(&e);
    let id = register(&c, &owner, &point(&e, G));
    propose(&c, &owner, id, &first, 50).unwrap().unwrap();

    propose(&c, &owner, id, &second, 80).unwrap().unwrap();

    assert_eq!(
        c.pending_owner(&id),
        Some(PendingOwner {
            new_owner: second.clone(),
            live_until_ledger: 80
        })
    );
    assert_eq!(failure(accept(&c, &first, id)), refused());
    assert_eq!(accept(&c, &second, id), Ok(Ok(())));
    assert_eq!(c.owner_of(&id), second);
}

#[test]
fn propose_unknown_id_fails() {
    let (e, c) = setup();
    let someone = Address::generate(&e);

    let outcome = propose(&c, &someone, 0, &Address::generate(&e), 50);

    assert_eq!(failure(outcome), RegistryError::UnknownAuditor.into());
}

#[test]
fn owner_cancels_the_offer() {
    let (e, c) = setup();
    let owner = Address::generate(&e);
    let proposed = Address::generate(&e);
    let id = register(&c, &owner, &point(&e, G));
    propose(&c, &owner, id, &proposed, 50).unwrap().unwrap();

    assert_eq!(cancel(&c, &owner, id), Ok(Ok(())));

    assert_eq!(
        e.events().all(),
        std::vec![OwnerProposalCancelled { auditor_id: id }.to_xdr(&e, &c.address)]
    );
    assert_eq!(c.pending_owner(&id), None);
    assert_eq!(
        failure(accept(&c, &proposed, id)),
        RegistryError::NoPendingOwner.into()
    );
    assert_eq!(c.owner_of(&id), owner);
}

#[test]
fn cancel_by_anyone_but_the_owner_fails() {
    let (e, c) = setup();
    let owner = Address::generate(&e);
    let proposed = Address::generate(&e);
    let attacker = Address::generate(&e);
    let id = register(&c, &owner, &point(&e, G));
    propose(&c, &owner, id, &proposed, 50).unwrap().unwrap();

    for stranger in [&attacker, &proposed] {
        assert_eq!(failure(cancel(&c, stranger, id)), refused());
    }
    assert_eq!(
        c.pending_owner(&id),
        Some(PendingOwner {
            new_owner: proposed,
            live_until_ledger: 50
        })
    );
    assert_eq!(cancel(&c, &owner, id), Ok(Ok(())));
}

#[test]
fn cancel_without_an_offer_fails() {
    let (e, c) = setup();
    let owner = Address::generate(&e);
    let id = register(&c, &owner, &point(&e, G));

    assert_eq!(
        failure(cancel(&c, &owner, id)),
        RegistryError::NoPendingOwner.into()
    );
}

#[test]
fn cancel_unknown_id_fails() {
    let (e, c) = setup();
    let someone = Address::generate(&e);

    assert_eq!(
        failure(cancel(&c, &someone, 0)),
        RegistryError::UnknownAuditor.into()
    );
}

#[test]
fn accept_hands_over_control() {
    let (e, c) = setup();
    let owner = Address::generate(&e);
    let new_owner = Address::generate(&e);
    let id = register(&c, &owner, &point(&e, G));
    propose(&c, &owner, id, &new_owner, 50).unwrap().unwrap();

    assert_eq!(accept(&c, &new_owner, id), Ok(Ok(())));

    assert_eq!(
        e.events().all(),
        std::vec![OwnerChanged {
            auditor_id: id,
            previous_owner: owner.clone(),
            new_owner: new_owner.clone()
        }
        .to_xdr(&e, &c.address)]
    );
    assert_eq!(c.owner_of(&id), new_owner);
    assert_eq!(c.pending_owner(&id), None);
    assert_eq!(failure(rotate(&c, &owner, id, &point(&e, PVK))), refused());
    assert_eq!(failure(propose(&c, &owner, id, &owner, 60)), refused());
    assert_eq!(rotate(&c, &new_owner, id, &point(&e, PVK)), Ok(Ok(())));
    assert_eq!(propose(&c, &new_owner, id, &owner, 60), Ok(Ok(())));
    assert_eq!(c.get_key(&id), point(&e, PVK));
}

#[test]
fn accept_by_anyone_but_the_proposed_address_fails() {
    let (e, c) = setup();
    let owner = Address::generate(&e);
    let proposed = Address::generate(&e);
    let attacker = Address::generate(&e);
    let id = register(&c, &owner, &point(&e, G));
    propose(&c, &owner, id, &proposed, 50).unwrap().unwrap();

    for stranger in [&attacker, &owner] {
        assert_eq!(failure(accept(&c, stranger, id)), refused());
    }
    assert_eq!(c.owner_of(&id), owner);
    assert_eq!(
        c.pending_owner(&id),
        Some(PendingOwner {
            new_owner: proposed.clone(),
            live_until_ledger: 50
        })
    );
    assert_eq!(accept(&c, &proposed, id), Ok(Ok(())));
}

#[test]
fn accept_on_the_deadline_ledger_succeeds() {
    let (e, c) = setup();
    let owner = Address::generate(&e);
    let new_owner = Address::generate(&e);
    let id = register(&c, &owner, &point(&e, G));
    propose(&c, &owner, id, &new_owner, 50).unwrap().unwrap();
    set_ledger(&e, 50);

    assert_eq!(accept(&c, &new_owner, id), Ok(Ok(())));
    assert_eq!(c.owner_of(&id), new_owner);
}

#[test]
fn accept_after_the_deadline_fails() {
    let (e, c) = setup();
    let owner = Address::generate(&e);
    let new_owner = Address::generate(&e);
    let id = register(&c, &owner, &point(&e, G));
    propose(&c, &owner, id, &new_owner, 50).unwrap().unwrap();
    set_ledger(&e, 51);

    assert_eq!(
        failure(accept(&c, &new_owner, id)),
        RegistryError::OwnerTransferExpired.into()
    );
    assert_eq!(c.owner_of(&id), owner);
    // An expired offer stays visible until the owner clears it.
    assert_eq!(cancel(&c, &owner, id), Ok(Ok(())));
    assert_eq!(c.pending_owner(&id), None);
}

#[test]
fn accept_without_an_offer_fails() {
    let (e, c) = setup();
    let owner = Address::generate(&e);
    let id = register(&c, &owner, &point(&e, G));

    assert_eq!(
        failure(accept(&c, &owner, id)),
        RegistryError::NoPendingOwner.into()
    );
}

#[test]
fn accept_unknown_id_fails() {
    let (e, c) = setup();
    let someone = Address::generate(&e);

    assert_eq!(
        failure(accept(&c, &someone, 0)),
        RegistryError::UnknownAuditor.into()
    );
}

#[test]
fn reads_of_an_unknown_id_fail() {
    let (e, c) = setup();
    let owner = Address::generate(&e);
    register(&c, &owner, &point(&e, G));

    assert_eq!(
        failure(c.try_get_key(&1)),
        AuditorError::AuditorNotRegistered.into()
    );
    assert_eq!(
        failure(c.try_owner_of(&1)),
        RegistryError::UnknownAuditor.into()
    );
    assert_eq!(
        failure(c.try_pending_owner(&1)),
        RegistryError::UnknownAuditor.into()
    );
    assert_eq!(
        failure(c.try_get_key(&u32::MAX)),
        AuditorError::AuditorNotRegistered.into()
    );
}

#[test]
fn writes_extend_instance_key_and_owner_lifetimes() {
    let (e, c) = setup();
    let owner = Address::generate(&e);
    let id = register(&c, &owner, &point(&e, G));
    let lifetimes = || {
        e.as_contract(&c.address, || {
            (
                e.storage().instance().get_ttl(),
                e.storage()
                    .persistent()
                    .get_ttl(&AuditorStorageKey::Key(id)),
                e.storage()
                    .persistent()
                    .get_ttl(&RegistryStorageKey::Owner(id)),
            )
        })
    };
    assert_eq!(
        lifetimes(),
        (
            INSTANCE_EXTEND_AMOUNT,
            AUDITOR_KEY_EXTEND_AMOUNT,
            OWNER_EXTEND_AMOUNT
        )
    );

    set_ledger(&e, 2 * DAY);
    assert!(lifetimes().2 <= OWNER_TTL_THRESHOLD);
    rotate(&c, &owner, id, &point(&e, DEAD_H)).unwrap().unwrap();

    assert_eq!(
        lifetimes(),
        (
            INSTANCE_EXTEND_AMOUNT,
            AUDITOR_KEY_EXTEND_AMOUNT,
            OWNER_EXTEND_AMOUNT
        )
    );
}

#[test]
fn get_key_extends_instance_key_and_owner_lifetimes() {
    let (e, c) = setup();
    let owner = Address::generate(&e);
    let id = register(&c, &owner, &point(&e, G));
    set_ledger(&e, 2 * DAY);

    c.get_key(&id);

    let lifetimes = e.as_contract(&c.address, || {
        (
            e.storage().instance().get_ttl(),
            e.storage()
                .persistent()
                .get_ttl(&AuditorStorageKey::Key(id)),
            e.storage()
                .persistent()
                .get_ttl(&RegistryStorageKey::Owner(id)),
        )
    });
    assert_eq!(
        lifetimes,
        (
            INSTANCE_EXTEND_AMOUNT,
            AUDITOR_KEY_EXTEND_AMOUNT,
            OWNER_EXTEND_AMOUNT
        )
    );
}

#[test]
fn an_offer_stays_stored_until_its_deadline() {
    let (e, c) = setup();
    let owner = Address::generate(&e);
    let new_owner = Address::generate(&e);
    let id = register(&c, &owner, &point(&e, G));
    set_ledger(&e, 10);
    // Longer than both the 30 day owner window and the network's minimum entry lifetime.
    let deadline = 10 + 60 * DAY;

    propose(&c, &owner, id, &new_owner, deadline)
        .unwrap()
        .unwrap();

    let lifetime = e.as_contract(&c.address, || {
        e.storage()
            .persistent()
            .get_ttl(&RegistryStorageKey::PendingOwner(id))
    });
    assert_eq!(lifetime, deadline - 10);
}

#[test]
fn contract_state_holds_nothing_but_keys_owners_and_offers() {
    let (e, c) = setup();
    let alice = Address::generate(&e);
    let bob = Address::generate(&e);
    let carol = Address::generate(&e);
    let first = register(&c, &alice, &point(&e, G));
    let second = register(&c, &bob, &point(&e, DEAD_H));
    propose(&c, &alice, first, &carol, 100).unwrap().unwrap();
    accept(&c, &carol, first).unwrap().unwrap();
    propose(&c, &bob, second, &alice, 200).unwrap().unwrap();

    e.as_contract(&c.address, || {
        let instance = Map::<Val, Val>::from_array(
            &e,
            [(RegistryStorageKey::KeyCount.into_val(&e), 2u32.into_val(&e))],
        );
        let persistent = Map::<Val, Val>::from_array(
            &e,
            [
                (
                    AuditorStorageKey::Key(first).into_val(&e),
                    point(&e, G).into_val(&e),
                ),
                (
                    AuditorStorageKey::Key(second).into_val(&e),
                    point(&e, DEAD_H).into_val(&e),
                ),
                (
                    RegistryStorageKey::Owner(first).into_val(&e),
                    carol.into_val(&e),
                ),
                (
                    RegistryStorageKey::Owner(second).into_val(&e),
                    bob.into_val(&e),
                ),
                (
                    RegistryStorageKey::PendingOwner(second).into_val(&e),
                    PendingOwner {
                        new_owner: alice.clone(),
                        live_until_ledger: 200,
                    }
                    .into_val(&e),
                ),
            ],
        );
        assert_eq!(e.storage().instance().all(), instance);
        assert_eq!(e.storage().persistent().all(), persistent);
        assert_eq!(e.storage().temporary().all().len(), 0);
    });
}

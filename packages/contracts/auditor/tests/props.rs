//! Property test: random sequences of register, rotate, propose, cancel and
//! accept calls, each signed by a random actor (an owner, a proposed owner or a
//! stranger), checked after every step against a plain model of what the
//! registry promises (AR1, AR3, AR4, AR6).
//!
//! Not covered here: events and storage lifetimes (src/test.rs), the real
//! confidential token (tests/token_integration.rs), point validation beyond
//! the identity and one off-curve point, deadlines near the network's maximum
//! entry lifetime, ledgers more than a few thousand apart, and the compiled
//! wasm.

use kalypso_auditor::{AuditorRegistry, AuditorRegistryClient, PendingOwner, RegistryError};
use proptest::prelude::*;
use soroban_sdk::{
    testutils::{Address as _, EnvTestConfig, Ledger as _, MockAuth, MockAuthInvoke},
    xdr::{ScErrorCode, ScErrorType},
    Address, BytesN, Env, Error, IntoVal, InvokeError, Val, Vec,
};
use stellar_tokens::confidential::auditor::AuditorError;

const ACTORS: usize = 4;
// One past the ids a run usually reaches, so calls on unknown ids happen too.
const MAX_ID: u32 = 4;

// Valid points from OpenZeppelin's 98090b3 fixtures (G from the auditor tests,
// the rest from circuits/lib/testdata), then the identity and the off-curve (1, 2).
const KEYS: [(&str, &str); 6] = [
    (
        "0000000000000000000000000000000000000000000000000000000000000001",
        "0000000000000002cf135e7506a45d632d270d45f1181294833fc48d823f272c",
    ),
    (
        "1b46b003b88a6c34549dc74115f088f4b231a151397526bc10cbf1d15b457646",
        "29116280600c10ead1fdbd9ab4b571896030679bf554d7f1ebf681e5147de21b",
    ),
    (
        "2e7421c0e86a4c8eed823edf851c364ecee448bf70eae2a95befe3dd9364cc45",
        "0b060655740aabef84e7305bb886b75da8d258f346381f03925d69645292fe7a",
    ),
    (
        "195a5d8ecd032fe1696054b28f0852b5f03a613681991ace823245ab2f97ed05",
        "0e67489ecfee0e581dce7db22a383c635886cfb616c3b3bb033bff0c46e9789e",
    ),
    (
        "0000000000000000000000000000000000000000000000000000000000000000",
        "0000000000000000000000000000000000000000000000000000000000000000",
    ),
    (
        "0000000000000000000000000000000000000000000000000000000000000001",
        "0000000000000000000000000000000000000000000000000000000000000002",
    ),
];
const IDENTITY_KEY: usize = 4;
const OFF_CURVE_KEY: usize = 5;

/// Who signs a call, drawn as a role so the run reaches successful handovers
/// often. It is turned into one concrete actor before the call, and both the
/// model and the contract judge the call by that actor alone.
#[derive(Clone, Copy, Debug)]
enum Signer {
    /// The id's current owner (for a registration: the owner being named).
    Owner,
    /// The address the id is currently offered to.
    Proposed,
    /// Any actor, which may or may not be the owner.
    Actor(usize),
}

#[derive(Clone, Debug)]
enum Op {
    Register {
        signer: Signer,
        owner: usize,
        key: usize,
    },
    Rotate {
        signer: Signer,
        id: u32,
        key: usize,
    },
    Propose {
        signer: Signer,
        id: u32,
        to: usize,
        window: u32,
    },
    Cancel {
        signer: Signer,
        id: u32,
    },
    Accept {
        signer: Signer,
        id: u32,
    },
    Wait {
        ledgers: u32,
    },
}

fn op() -> impl Strategy<Value = Op> {
    let signer = || {
        prop_oneof![
            3 => Just(Signer::Owner),
            2 => Just(Signer::Proposed),
            2 => (0..ACTORS).prop_map(Signer::Actor),
        ]
    };
    let actor = || 0..ACTORS;
    let id = || prop_oneof![6 => 0..=1u32, 3 => 0..=2u32, 1 => 0..=MAX_ID];
    let key =
        || prop_oneof![8 => 0..IDENTITY_KEY, 1 => Just(IDENTITY_KEY), 1 => Just(OFF_CURVE_KEY)];
    prop_oneof![
        3 => (signer(), actor(), key()).prop_map(|(signer, owner, key)| Op::Register { signer, owner, key }),
        3 => (signer(), id(), key()).prop_map(|(signer, id, key)| Op::Rotate { signer, id, key }),
        3 => (signer(), id(), actor(), 0..=20u32)
            .prop_map(|(signer, id, to, window)| Op::Propose { signer, id, to, window }),
        2 => (signer(), id()).prop_map(|(signer, id)| Op::Cancel { signer, id }),
        4 => (signer(), id()).prop_map(|(signer, id)| Op::Accept { signer, id }),
        3 => (1..=15u32).prop_map(|ledgers| Op::Wait { ledgers }),
    ]
}

/// What the registry promises, written as plainly as possible.
#[derive(Default)]
struct Model {
    ids: std::vec::Vec<Entry>,
    ledger: u32,
}

struct Entry {
    owner: usize,
    key: usize,
    pending: Option<(usize, u32)>,
}

fn refused() -> Error {
    // The host narrows a refused signature to this code across a try call.
    Error::from_type_and_code(ScErrorType::Context, ScErrorCode::InvalidAction)
}

fn key_error(key: usize) -> Option<Error> {
    match key {
        IDENTITY_KEY => Some(AuditorError::IdentityPoint.into()),
        OFF_CURVE_KEY => Some(AuditorError::PointNotOnCurve.into()),
        _ => None,
    }
}

impl Model {
    /// The concrete actor who signs `op`. Roles that do not apply (an unknown
    /// id, no offer pending) fall back to actor 0.
    fn signer_of(&self, op: &Op) -> usize {
        let (signer, id) = match *op {
            Op::Register {
                signer: Signer::Owner,
                owner,
                ..
            } => return owner,
            Op::Register { signer, .. } => (signer, None),
            Op::Rotate { signer, id, .. }
            | Op::Propose { signer, id, .. }
            | Op::Cancel { signer, id }
            | Op::Accept { signer, id } => (signer, self.ids.get(id as usize)),
            Op::Wait { .. } => return 0,
        };
        match signer {
            Signer::Owner => id.map_or(0, |entry| entry.owner),
            Signer::Proposed => id.and_then(|entry| entry.pending).map_or(0, |(to, _)| to),
            Signer::Actor(actor) => actor,
        }
    }

    /// Applies `op`, signed by `signer`, and returns the outcome the registry
    /// must produce: the new id for a registration, nothing for other
    /// successes, or the error.
    fn apply(&mut self, op: &Op, signer: usize) -> Result<Option<u32>, Error> {
        let unknown: Error = RegistryError::UnknownAuditor.into();
        let no_pending: Error = RegistryError::NoPendingOwner.into();
        match *op {
            Op::Register { owner, key, .. } => {
                if signer != owner {
                    return Err(refused());
                }
                if let Some(error) = key_error(key) {
                    return Err(error);
                }
                self.ids.push(Entry {
                    owner,
                    key,
                    pending: None,
                });
                Ok(Some(self.ids.len() as u32 - 1))
            }
            Op::Rotate { id, key, .. } => {
                let entry = self.ids.get_mut(id as usize).ok_or(unknown)?;
                if signer != entry.owner {
                    return Err(refused());
                }
                if let Some(error) = key_error(key) {
                    return Err(error);
                }
                entry.key = key;
                Ok(None)
            }
            Op::Propose { id, to, window, .. } => {
                let entry = self.ids.get_mut(id as usize).ok_or(unknown)?;
                if signer != entry.owner {
                    return Err(refused());
                }
                if to == entry.owner {
                    return Err(RegistryError::SameOwner.into());
                }
                if window == 0 {
                    return Err(RegistryError::InvalidLiveUntil.into());
                }
                entry.pending = Some((to, self.ledger + window));
                Ok(None)
            }
            Op::Cancel { id, .. } => {
                let entry = self.ids.get_mut(id as usize).ok_or(unknown)?;
                if signer != entry.owner {
                    return Err(refused());
                }
                if entry.pending.take().is_none() {
                    return Err(no_pending);
                }
                Ok(None)
            }
            Op::Accept { id, .. } => {
                let ledger = self.ledger;
                let entry = self.ids.get_mut(id as usize).ok_or(unknown)?;
                let (to, until) = entry.pending.ok_or(no_pending)?;
                if ledger > until {
                    return Err(RegistryError::OwnerTransferExpired.into());
                }
                if signer != to {
                    return Err(refused());
                }
                entry.owner = to;
                entry.pending = None;
                Ok(None)
            }
            Op::Wait { ledgers } => {
                self.ledger += ledgers;
                Ok(None)
            }
        }
    }
}

struct World<'a> {
    e: Env,
    registry: AuditorRegistryClient<'a>,
    actors: std::vec::Vec<Address>,
    keys: std::vec::Vec<BytesN<64>>,
}

fn point(e: &Env, (x, y): (&str, &str)) -> BytesN<64> {
    let hex = [x, y].concat();
    let mut bytes = [0u8; 64];
    for (i, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).unwrap();
    }
    BytesN::from_array(e, &bytes)
}

type Outcome<T> = Result<Result<T, soroban_sdk::ConversionError>, Result<Error, InvokeError>>;

fn settle<T>(outcome: Outcome<T>) -> Result<T, Error> {
    match outcome {
        Ok(Ok(value)) => Ok(value),
        Err(Ok(error)) => Err(error),
        Ok(Err(conversion)) => panic!("could not decode the return value: {conversion:?}"),
        Err(Err(invoke)) => panic!("call aborted without an error code: {invoke:?}"),
    }
}

impl World<'_> {
    fn new() -> Self {
        let e = Env::new_with_config(EnvTestConfig {
            capture_snapshot_at_drop: false,
        });
        let registry = AuditorRegistryClient::new(&e, &e.register(AuditorRegistry, ()));
        let actors = (0..ACTORS).map(|_| Address::generate(&e)).collect();
        let keys = KEYS.iter().map(|&fixture| point(&e, fixture)).collect();
        World {
            e,
            registry,
            actors,
            keys,
        }
    }

    fn sign(&self, signer: usize, fn_name: &str, args: Vec<Val>) {
        self.e.mock_auths(&[MockAuth {
            address: &self.actors[signer],
            invoke: &MockAuthInvoke {
                contract: &self.registry.address,
                fn_name,
                args,
                sub_invokes: &[],
            },
        }]);
    }

    fn run(&self, op: &Op, signer: usize) -> Result<Option<u32>, Error> {
        let e = &self.e;
        let r = &self.registry;
        match *op {
            Op::Register { owner, key, .. } => {
                let (owner, key) = (&self.actors[owner], &self.keys[key]);
                self.sign(
                    signer,
                    "register_key",
                    (owner.clone(), key.clone()).into_val(e),
                );
                settle(r.try_register_key(owner, key)).map(Some)
            }
            Op::Rotate { id, key, .. } => {
                let key = &self.keys[key];
                self.sign(signer, "rotate_key", (id, key.clone()).into_val(e));
                settle(r.try_rotate_key(&id, key)).map(|_| None)
            }
            Op::Propose { id, to, window, .. } => {
                let (to, until) = (&self.actors[to], e.ledger().sequence() + window);
                self.sign(signer, "propose_owner", (id, to.clone(), until).into_val(e));
                settle(r.try_propose_owner(&id, to, &until)).map(|_| None)
            }
            Op::Cancel { id, .. } => {
                self.sign(signer, "cancel_owner_proposal", (id,).into_val(e));
                settle(r.try_cancel_owner_proposal(&id)).map(|_| None)
            }
            Op::Accept { id, .. } => {
                self.sign(signer, "accept_owner", (id,).into_val(e));
                settle(r.try_accept_owner(&id)).map(|_| None)
            }
            Op::Wait { ledgers } => {
                e.ledger()
                    .set_sequence_number(e.ledger().sequence() + ledgers);
                Ok(None)
            }
        }
    }

    fn assert_matches(&self, model: &Model) {
        let r = &self.registry;
        // AR3: ids are exactly 0..count, in order, none skipped or reused.
        assert_eq!(r.key_count(), model.ids.len() as u32);
        for (id, entry) in model.ids.iter().enumerate() {
            let id = id as u32;
            // AR1 and AR6: the key is the last one registered or rotated, and
            // the model only rotates when the current owner signed.
            assert_eq!(r.get_key(&id), self.keys[entry.key]);
            // AR1 and AR4: control moves only through an accepted, unexpired handover.
            assert_eq!(r.owner_of(&id), self.actors[entry.owner]);
            // AR4: the offer on record is the last one proposed until it is
            // accepted or cancelled. Expiry blocks acceptance but does not erase it.
            let pending = entry.pending.map(|(to, until)| PendingOwner {
                new_owner: self.actors[to].clone(),
                live_until_ledger: until,
            });
            assert_eq!(r.pending_owner(&id), pending);
        }
        // AR6: the first unused id has no key, so the token's register would fail.
        let unused = model.ids.len() as u32;
        assert_eq!(
            settle(r.try_get_key(&unused)),
            Err(AuditorError::AuditorNotRegistered.into())
        );
        assert_eq!(
            settle(r.try_owner_of(&unused)),
            Err(RegistryError::UnknownAuditor.into())
        );
    }
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 256, ..ProptestConfig::default() })]

    #[test]
    fn registry_matches_its_model_under_random_calls(ops in prop::collection::vec(op(), 8..64)) {
        let world = World::new();
        let mut model = Model::default();

        for op in &ops {
            let signer = model.signer_of(op);
            let expected = model.apply(op, signer);
            let actual = world.run(op, signer);
            prop_assert_eq!(actual, expected, "outcome of {:?} signed by actor {}", op, signer);
            world.assert_matches(&model);
        }
    }
}

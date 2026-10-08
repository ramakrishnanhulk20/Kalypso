//! Attacks on the auditor registry that the per-function tests do not make,
//! each shown being refused, run with this registry wired into the real
//! OpenZeppelin token wasm (fixtures/confidential_token.wasm) behind a
//! verifier that accepts every proof.
//!
//! Not covered here: real proofs, fees, rent and transaction size, and the
//! payroll contract. A treasury bound to an id somebody else registered
//! first is refused by the payroll's create_company, in
//! payroll/tests/attacks.rs, because that refusal needs the payroll.

use kalypso_auditor::{AuditorRegistry, AuditorRegistryClient, RegistryError};
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, EnvTestConfig, MockAuth, MockAuthInvoke},
    xdr::{ScErrorCode, ScErrorType, ToXdr},
    Address, Bytes, BytesN, Env, Error, IntoVal, InvokeError, Val, Vec,
};
use stellar_tokens::confidential::{
    storage::{RegisterData, RegisterPayload},
    verifier::CircuitType,
    ConfidentialTokenClient, ConfidentialTokenError,
};

const TOKEN_WASM: &[u8] = include_bytes!("../../fixtures/confidential_token.wasm");

// Points from OpenZeppelin's 98090b3 fixtures: G from the auditor tests,
// Y = 0xdead * H and PVK = vk * H from circuits/lib/testdata.
const G: (&str, &str) = (
    "0000000000000000000000000000000000000000000000000000000000000001",
    "0000000000000002cf135e7506a45d632d270d45f1181294833fc48d823f272c",
);
const DEAD_H: (&str, &str) = (
    "1b46b003b88a6c34549dc74115f088f4b231a151397526bc10cbf1d15b457646",
    "29116280600c10ead1fdbd9ab4b571896030679bf554d7f1ebf681e5147de21b",
);
const PVK: (&str, &str) = (
    "2e7421c0e86a4c8eed823edf851c364ecee448bf70eae2a95befe3dd9364cc45",
    "0b060655740aabef84e7305bb886b75da8d258f346381f03925d69645292fe7a",
);

/// Stands in for the UltraHonk verifier so no real proof is needed.
#[contract]
pub struct AcceptingVerifier;

#[contractimpl]
impl AcceptingVerifier {
    pub fn verify_proof(_e: Env, _circuit_type: CircuitType, _public_inputs: Bytes, _proof: Bytes) -> bool {
        true
    }
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

fn failure<T: core::fmt::Debug>(outcome: Outcome<T>) -> Error {
    match outcome {
        Err(Ok(error)) => error,
        other => panic!("expected a failure with an error code, got {other:?}"),
    }
}

fn refused() -> Error {
    Error::from_type_and_code(ScErrorType::Context, ScErrorCode::InvalidAction)
}

fn sign(e: &Env, signer: &Address, contract: &Address, fn_name: &str, args: Vec<Val>) {
    e.mock_auths(&[MockAuth {
        address: signer,
        invoke: &MockAuthInvoke {
            contract,
            fn_name,
            args,
            sub_invokes: &[],
        },
    }]);
}

struct Stack<'a> {
    e: Env,
    registry: AuditorRegistryClient<'a>,
    token: ConfidentialTokenClient<'a>,
}

fn deploy<'a>() -> Stack<'a> {
    let e = Env::new_with_config(EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    let usdc = e.register_stellar_asset_contract_v2(Address::generate(&e));
    let verifier = e.register(AcceptingVerifier, ());
    let registry = e.register(AuditorRegistry, ());
    let token = e.register(TOKEN_WASM, (usdc.address(), verifier, registry.clone()));
    Stack {
        registry: AuditorRegistryClient::new(&e, &registry),
        token: ConfidentialTokenClient::new(&e, &token),
        e,
    }
}

impl Stack<'_> {
    fn register_data(&self) -> Bytes {
        RegisterData {
            payload: RegisterPayload {
                y: point(&self.e, DEAD_H),
                pvk: point(&self.e, PVK),
            },
            proof: Bytes::new(&self.e),
        }
        .to_xdr(&self.e)
    }

    fn register_key(&self, owner: &Address, key: &BytesN<64>) -> u32 {
        sign(
            &self.e,
            owner,
            &self.registry.address,
            "register_key",
            (owner.clone(), key.clone()).into_val(&self.e),
        );
        self.registry.register_key(owner, key)
    }

    fn try_rotate(&self, signer: &Address, id: u32, key: &BytesN<64>) -> Outcome<()> {
        sign(&self.e, signer, &self.registry.address, "rotate_key", (id, key.clone()).into_val(&self.e));
        self.registry.try_rotate_key(&id, key)
    }

    fn try_propose(&self, signer: &Address, id: u32, to: &Address, until: u32) -> Outcome<()> {
        sign(
            &self.e,
            signer,
            &self.registry.address,
            "propose_owner",
            (id, to.clone(), until).into_val(&self.e),
        );
        self.registry.try_propose_owner(&id, to, &until)
    }

    /// The real token's `register`, signed by the account.
    fn try_register_account(&self, account: &Address, auditor_id: u32) -> Result<(), Error> {
        let data = self.register_data();
        sign(
            &self.e,
            account,
            &self.token.address,
            "register",
            (account.clone(), auditor_id, data.clone()).into_val(&self.e),
        );
        match self.token.try_register(account, &auditor_id, &data) {
            Ok(Ok(())) => Ok(()),
            Err(Ok(error)) => Err(error),
            other => panic!("unexpected outcome: {other:?}"),
        }
    }
}

/// C33 against the real token: an account's auditor id is fixed the moment it
/// registers. Neither the same id nor another one can be registered again,
/// so a worker or treasury bound to the wrong id has no on-chain way back.
#[test]
fn refuses_a_second_token_registration_under_any_auditor_id() {
    let s = deploy();
    let accountant = Address::generate(&s.e);
    let other = Address::generate(&s.e);
    let worker = Address::generate(&s.e);
    let first = s.register_key(&accountant, &point(&s.e, G));
    let second = s.register_key(&other, &point(&s.e, DEAD_H));
    assert_eq!(s.try_register_account(&worker, first), Ok(()));

    for id in [first, second] {
        assert_eq!(
            s.try_register_account(&worker, id),
            Err(ConfidentialTokenError::AccountAlreadyRegistered.into())
        );
    }
    assert_eq!(s.token.confidential_balance(&worker).auditor_id, first);
}

/// C2: being bound to an id gives no power over it. The treasury registered
/// under the accountant's id can neither rotate the key its payments are
/// encrypted to nor offer the id to itself, and an unknown id fails before
/// any signature is looked at.
#[test]
fn refuses_rotation_and_handover_by_the_account_bound_to_the_id() {
    let s = deploy();
    let accountant = Address::generate(&s.e);
    let treasury = Address::generate(&s.e);
    let id = s.register_key(&accountant, &point(&s.e, G));
    assert_eq!(s.try_register_account(&treasury, id), Ok(()));

    assert_eq!(failure(s.try_rotate(&treasury, id, &point(&s.e, DEAD_H))), refused());
    assert_eq!(failure(s.try_propose(&treasury, id, &treasury, 50)), refused());
    assert_eq!(
        failure(s.try_rotate(&treasury, id + 1, &point(&s.e, DEAD_H))),
        RegistryError::UnknownAuditor.into()
    );
    assert_eq!(s.registry.get_key(&id), point(&s.e, G));
    assert_eq!(s.registry.owner_of(&id), accountant);
    assert_eq!(s.registry.pending_owner(&id), None);
}

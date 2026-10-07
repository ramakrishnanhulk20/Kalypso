//! Integration test with the real confidential token: OpenZeppelin's compiled
//! wasm at 98090b3 (fixtures/confidential_token.wasm, the same bytes as the
//! testnet deployment), using this registry as its auditor. It shows the
//! token's `register` succeeds for an id the registry holds and fails for one
//! it does not (AR6).
//!
//! Not covered here: real proofs (the verifier below accepts every proof, so
//! nothing here says the register circuit accepts these keys), the token's
//! other entry points, transfers actually encrypting to the auditor key,
//! testnet behaviour and fees.

use kalypso_auditor::{AuditorRegistry, AuditorRegistryClient};
use soroban_sdk::{
    contract, contractimpl,
    testutils::{Address as _, EnvTestConfig, MockAuth, MockAuthInvoke},
    xdr::{FromXdr, ToXdr},
    Address, Bytes, BytesN, Env, Error, IntoVal, Val, Vec,
};
use stellar_tokens::confidential::{
    auditor::AuditorError,
    storage::{RegisterData, RegisterPayload},
    verifier::CircuitType,
    ConfidentialTokenClient, ConfidentialTokenError,
};

const TOKEN_WASM: &[u8] = include_bytes!("../../fixtures/confidential_token.wasm");

// Spending key Y = 0xdead * H and viewing key PVK, from circuits/lib/testdata
// (scalar_mul.json, pvk_from_vk.json) at 98090b3. G is the auditor key.
const DEAD_H: (&str, &str) = (
    "1b46b003b88a6c34549dc74115f088f4b231a151397526bc10cbf1d15b457646",
    "29116280600c10ead1fdbd9ab4b571896030679bf554d7f1ebf681e5147de21b",
);
const PVK: (&str, &str) = (
    "2e7421c0e86a4c8eed823edf851c364ecee448bf70eae2a95befe3dd9364cc45",
    "0b060655740aabef84e7305bb886b75da8d258f346381f03925d69645292fe7a",
);
const G: (&str, &str) = (
    "0000000000000000000000000000000000000000000000000000000000000001",
    "0000000000000002cf135e7506a45d632d270d45f1181294833fc48d823f272c",
);

// The `data` bytes the client SDK builds for its pinned register vector
// (stellar-confidential-token-sdk 45178c4, packages/sdk/src/chain/test/vectors/register.hex,
// without the 8-byte scvBytes header around them). Proof is 64 bytes of 0x07.
const SDK_REGISTER_DATA: &str = concat!(
    "0000001100000001000000020000000f000000077061796c6f6164000000001100000001000000020000000f",
    "0000000370766b000000000d0000004018f62b5252eeff6782dfd329542181786f22cb01ef40595e4f3e3009",
    "cdd5a364062e79a3cfc3c40e07345259cb432166e47449d01f2f3c723d9d426e242c35d20000000f00000001",
    "790000000000000d000000402d4a0d872d1283f202ce9f6049e84f42d8240295c57d362f21b35bc06bfcfa3e",
    "17ad641f6d6a5d7eeec9b49813a2bde13d8f9342ce51cd315aa399321e739c9e0000000f0000000570726f6f",
    "660000000000000d000000400707070707070707070707070707070707070707070707070707070707070707",
    "0707070707070707070707070707070707070707070707070707070707070707",
);

/// Stands in for the UltraHonk verifier so the test needs no real proof.
#[contract]
pub struct AcceptingVerifier;

#[contractimpl]
impl AcceptingVerifier {
    pub fn verify_proof(
        _e: Env,
        _circuit_type: CircuitType,
        _public_inputs: Bytes,
        _proof: Bytes,
    ) -> bool {
        true
    }
}

fn bytes(e: &Env, hex: &str) -> Bytes {
    let raw: std::vec::Vec<u8> = (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&hex[i..i + 2], 16).unwrap())
        .collect();
    Bytes::from_slice(e, &raw)
}

fn point(e: &Env, (x, y): (&str, &str)) -> BytesN<64> {
    bytes(e, &[x, y].concat()).try_into().unwrap()
}

/// The `data` argument of the token's `register`: the XDR of
/// `{ payload: { y, pvk }, proof }`, built with the token's own type.
fn register_data(e: &Env, y: &BytesN<64>, pvk: &BytesN<64>, proof: Bytes) -> Bytes {
    RegisterData {
        payload: RegisterPayload {
            y: y.clone(),
            pvk: pvk.clone(),
        },
        proof,
    }
    .to_xdr(e)
}

struct Deployment<'a> {
    e: Env,
    registry: AuditorRegistryClient<'a>,
    token: ConfidentialTokenClient<'a>,
}

fn deploy<'a>() -> Deployment<'a> {
    let e = Env::new_with_config(EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    let usdc = e.register_stellar_asset_contract_v2(Address::generate(&e));
    let verifier = e.register(AcceptingVerifier, ());
    let registry = e.register(AuditorRegistry, ());
    let token = e.register(TOKEN_WASM, (usdc.address(), verifier, registry.clone()));
    Deployment {
        registry: AuditorRegistryClient::new(&e, &registry),
        token: ConfidentialTokenClient::new(&e, &token),
        e,
    }
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

impl Deployment<'_> {
    fn register_auditor(&self, accountant: &Address, key: &BytesN<64>) -> u32 {
        sign(
            &self.e,
            accountant,
            &self.registry.address,
            "register_key",
            (accountant.clone(), key.clone()).into_val(&self.e),
        );
        self.registry.register_key(accountant, key)
    }

    fn try_register_account(
        &self,
        account: &Address,
        auditor_id: u32,
        data: &Bytes,
    ) -> Result<(), Error> {
        sign(
            &self.e,
            account,
            &self.token.address,
            "register",
            (account.clone(), auditor_id, data.clone()).into_val(&self.e),
        );
        match self.token.try_register(account, &auditor_id, data) {
            Ok(Ok(())) => Ok(()),
            Err(Ok(error)) => Err(error),
            other => panic!("unexpected outcome: {other:?}"),
        }
    }
}

#[test]
fn register_data_matches_the_client_sdk_encoding() {
    let e = Env::new_with_config(EnvTestConfig {
        capture_snapshot_at_drop: false,
    });
    let sdk_bytes = bytes(&e, SDK_REGISTER_DATA);
    let decoded = RegisterData::from_xdr(&e, &sdk_bytes).unwrap();

    let rebuilt = register_data(
        &e,
        &decoded.payload.y,
        &decoded.payload.pvk,
        Bytes::from_array(&e, &[7u8; 64]),
    );

    assert_eq!(rebuilt, sdk_bytes);
}

#[test]
fn token_registers_an_account_under_a_registered_auditor_id() {
    let d = deploy();
    let accountant = Address::generate(&d.e);
    let worker = Address::generate(&d.e);
    let (y, pvk) = (point(&d.e, DEAD_H), point(&d.e, PVK));
    let auditor_id = d.register_auditor(&accountant, &point(&d.e, G));

    let outcome = d.try_register_account(
        &worker,
        auditor_id,
        &register_data(&d.e, &y, &pvk, Bytes::new(&d.e)),
    );

    assert_eq!(outcome, Ok(()));
    let account = d.token.confidential_balance(&worker);
    assert_eq!(account.auditor_id, auditor_id);
    assert_eq!(account.spending_public_key, y);
    assert_eq!(account.viewing_public_key, pvk);
}

#[test]
fn token_refuses_an_auditor_id_the_registry_does_not_hold() {
    let d = deploy();
    let accountant = Address::generate(&d.e);
    let worker = Address::generate(&d.e);
    let data = register_data(
        &d.e,
        &point(&d.e, DEAD_H),
        &point(&d.e, PVK),
        Bytes::new(&d.e),
    );
    d.register_auditor(&accountant, &point(&d.e, G));

    let outcome = d.try_register_account(&worker, 1, &data);

    assert_eq!(outcome, Err(AuditorError::AuditorNotRegistered.into()));
    let lookup = d.token.try_confidential_balance(&worker);
    assert_eq!(
        lookup.err(),
        Some(Ok(ConfidentialTokenError::AccountNotRegistered.into()))
    );
    // The same call goes through once id 1 exists, so the id was the only reason for the refusal.
    assert_eq!(d.register_auditor(&accountant, &point(&d.e, PVK)), 1);
    assert_eq!(d.try_register_account(&worker, 1, &data), Ok(()));
}

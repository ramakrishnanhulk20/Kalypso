//! Kalypso payroll: one shared contract that runs confidential payroll for
//! many companies.
//!
//! A company signs itself up with an admin account, and that account is also
//! the company's treasury. The admin invites workers, each worker accepts with
//! their own signature, then the admin opens a run and pays each worker a
//! hidden amount through OpenZeppelin's confidential token, at most once per
//! run. Every record is keyed by company id, so one company can never touch
//! another's runs, roster or paid flags.
//!
//! What this contract deliberately does not have:
//! - No pause, no rescue function, no owner or admin over the contract itself,
//!   and no upgrade path. It is immutable once deployed.
//! - No custody. It never holds funds: money moves straight from the
//!   employer's confidential balance to the worker's, inside a token call the
//!   employer signed as part of `pay`.
//! - No amounts. Nothing here stores or emits an amount. Amounts exist only
//!   inside the token's encrypted transfer data.
#![no_std]

mod contract;
mod errors;
mod events;
mod storage;
mod types;

/// Client and types generated from the exact token wasm running on testnet.
/// The sha256 pin makes the build fail if the fixture is ever swapped.
pub mod token {
    /// A Grumpkin curve point, `be(x) || be(y)`. Upstream declares it as a
    /// plain alias, so the wasm spec names `Point` without defining it and the
    /// generated types need it in scope.
    pub type Point = soroban_sdk::BytesN<64>;

    soroban_sdk::contractimport!(
        file = "../fixtures/confidential_token.wasm",
        sha256 = "c77ac818ab3af1a2b9cdbc54964d68070f106fb72c9172ba4fff186995704cfd"
    );
}

pub use contract::{
    Payroll, PayrollArgs, PayrollClient, MAX_BATCH, MAX_COMPANY_LABEL_BYTES,
    MAX_PERIOD_LABEL_BYTES, MAX_ROSTER_PAGE,
};
pub use errors::PayrollError;
pub use events::{
    AdminChanged, AdminProposalCancelled, AdminProposed, CompanyCreated, InviteRevoked,
    PayslipIssued, RunClosed, RunOpened, WorkerInvited, WorkerJoined, WorkerRemoved,
};
pub use storage::{
    DAY_IN_LEDGERS, INSTANCE_EXTEND_THRESHOLD, INSTANCE_EXTEND_TO, RECORD_EXTEND_THRESHOLD,
    RECORD_EXTEND_TO,
};
pub use types::{Company, PendingAdmin, Run, RunStatus, WorkerStatus};

#[cfg(test)]
mod test;

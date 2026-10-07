use soroban_sdk::{contracttype, Address, String};

/// One company. `admin` is also the treasury: `pay` moves money from whoever
/// is admin at that moment.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Company {
    pub admin: Address,
    /// The auditor id the admin is registered under in the token. Checked
    /// against the token at creation and at every admin handover.
    pub auditor_id: u32,
    /// Shown to other people as plain text. 1 to 64 bytes.
    pub label: String,
    pub created_ledger: u32,
    /// Workers whose status is `Active` right now.
    pub active_workers: u32,
    /// Length of the append-only roster. A worker is added the first time they
    /// join and never removed from the list, so the list is also the history.
    pub roster_len: u32,
}

#[contracttype]
#[derive(Copy, Clone, PartialEq, Eq, Debug)]
#[repr(u32)]
pub enum RunStatus {
    Open = 0,
    Closed = 1,
}

/// One pay run of one company, for example "October 2026".
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Run {
    pub status: RunStatus,
    /// Shown to other people as plain text. 1 to 32 bytes.
    pub period_label: String,
    /// The most payments this run can ever record.
    pub expected_count: u32,
    pub paid_count: u32,
    pub opened_ledger: u32,
}

#[contracttype]
#[derive(Copy, Clone, PartialEq, Eq, Debug)]
#[repr(u32)]
pub enum WorkerStatus {
    Invited = 0,
    Active = 1,
    Removed = 2,
}

/// An admin handover waiting for the incoming admin's signature.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingAdmin {
    pub new_admin: Address,
    /// The last ledger on which `accept_admin` still succeeds.
    pub live_until_ledger: u32,
}

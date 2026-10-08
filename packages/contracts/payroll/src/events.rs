//! Every event names its company first, so a reader can filter one company's
//! history with a single topic. The remaining topics are the other parts of
//! the record key (run id, worker), and everything else is data. No event
//! carries an amount.

use soroban_sdk::{contractevent, Address, String};

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CompanyCreated {
    #[topic]
    pub company_id: u64,
    pub admin: Address,
    /// The owner of `auditor_id` in the auditor registry at creation.
    pub accountant: Address,
    pub auditor_id: u32,
    pub label: String,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminProposed {
    #[topic]
    pub company_id: u64,
    pub new_admin: Address,
    pub live_until_ledger: u32,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminProposalCancelled {
    #[topic]
    pub company_id: u64,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminChanged {
    #[topic]
    pub company_id: u64,
    pub previous_admin: Address,
    pub new_admin: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkerInvited {
    #[topic]
    pub company_id: u64,
    #[topic]
    pub worker: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InviteRevoked {
    #[topic]
    pub company_id: u64,
    #[topic]
    pub worker: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkerJoined {
    #[topic]
    pub company_id: u64,
    #[topic]
    pub worker: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorkerRemoved {
    #[topic]
    pub company_id: u64,
    #[topic]
    pub worker: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunOpened {
    #[topic]
    pub company_id: u64,
    #[topic]
    pub run_id: u64,
    pub period_label: String,
    pub expected_count: u32,
}

/// Emitted once per worker paid, in the same call as the token transfer it
/// describes. The amount is not here: it lives only in the token's encrypted
/// transfer event.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PayslipIssued {
    #[topic]
    pub company_id: u64,
    #[topic]
    pub run_id: u64,
    #[topic]
    pub worker: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RunClosed {
    #[topic]
    pub company_id: u64,
    #[topic]
    pub run_id: u64,
    pub paid_count: u32,
}

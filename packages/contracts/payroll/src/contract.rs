use soroban_sdk::{contract, contractimpl, panic_with_error, Address, Bytes, Env, String, Vec};

use crate::errors::PayrollError;
use crate::events::{
    AdminChanged, AdminProposalCancelled, AdminProposed, CompanyCreated, InviteRevoked,
    PayslipIssued, RunClosed, RunOpened, WorkerInvited, WorkerJoined, WorkerRemoved,
};
use crate::storage::{self, WorkerRecord};
use crate::token;
use crate::types::{Company, PendingAdmin, Run, RunStatus, WorkerStatus};

/// Most payments one `pay` call accepts. Measured on testnet on 7 Oct 2026:
/// 2 payments make a 93,948 byte transaction and 3 make 140,432 bytes, against
/// the 132,096 byte transaction cap, because each ~15.4 KB proof travels three
/// times: in the call, in the signed root, and in the nested token call.
pub const MAX_BATCH: u32 = 2;
/// Cap on a company label, so stored strings stay small and bounded.
pub const MAX_COMPANY_LABEL_BYTES: u32 = 64;
/// Cap on a run's period label, for example "October 2026".
pub const MAX_PERIOD_LABEL_BYTES: u32 = 32;
/// Most roster entries one `get_roster` call returns, which bounds the read.
pub const MAX_ROSTER_PAGE: u32 = 50;

#[contract]
pub struct Payroll;

#[contractimpl]
impl Payroll {
    /// Binds the contract to one confidential token for its whole life.
    ///
    /// Runs once, inside the deploy transaction, so nobody can call it later
    /// and no signature is checked. Emits no event.
    pub fn __constructor(e: Env, token: Address) {
        storage::set_token(&e, &token);
        storage::extend_instance(&e);
    }

    /// Signs up a new company and returns its id. Ids start at 0 and count up.
    ///
    /// `admin` must authorize. `admin` becomes the company's treasury, so it
    /// must already be registered with the token, and the auditor id it is
    /// registered under must equal `auditor_id`.
    ///
    /// Fails with `LabelInvalid` if `label` is empty or longer than 64 bytes,
    /// `NotRegisteredWithToken` if the token has no account for `admin`, and
    /// `AuditorMismatch` if the registered auditor id differs.
    ///
    /// Emits `CompanyCreated`.
    pub fn create_company(e: Env, admin: Address, auditor_id: u32, label: String) -> u64 {
        admin.require_auth();
        require_label(&e, &label, MAX_COMPANY_LABEL_BYTES);
        require_registered_under(&e, &admin, auditor_id);

        let company_id = storage::next_company_id(&e);
        storage::set_next_company_id(&e, company_id + 1);
        let company = Company {
            admin: admin.clone(),
            auditor_id,
            label: label.clone(),
            created_ledger: e.ledger().sequence(),
            active_workers: 0,
            roster_len: 0,
        };
        storage::set_company(&e, company_id, &company);
        storage::extend_instance(&e);

        CompanyCreated {
            company_id,
            admin,
            auditor_id,
            label,
        }
        .publish(&e);
        company_id
    }

    /// Starts a two-step admin handover to `new_admin`, replacing any earlier
    /// proposal. The handover completes only when `new_admin` calls
    /// `accept_admin` on or before `live_until_ledger`.
    ///
    /// The current admin must authorize.
    ///
    /// Fails with `CompanyNotFound`, or `InvalidLiveUntil` if
    /// `live_until_ledger` is not after the current ledger.
    ///
    /// Emits `AdminProposed`.
    pub fn propose_admin(e: Env, company_id: u64, new_admin: Address, live_until_ledger: u32) {
        load_company_as_admin(&e, company_id);
        if live_until_ledger <= e.ledger().sequence() {
            panic_with_error!(&e, PayrollError::InvalidLiveUntil);
        }

        let pending = PendingAdmin {
            new_admin: new_admin.clone(),
            live_until_ledger,
        };
        storage::set_pending_admin(&e, company_id, &pending);
        storage::extend_instance(&e);

        AdminProposed {
            company_id,
            new_admin,
            live_until_ledger,
        }
        .publish(&e);
    }

    /// Withdraws the pending admin handover.
    ///
    /// The current admin must authorize.
    ///
    /// Fails with `CompanyNotFound`, or `NoPendingAdmin` if nothing is pending.
    ///
    /// Emits `AdminProposalCancelled`.
    pub fn cancel_admin_proposal(e: Env, company_id: u64) {
        load_company_as_admin(&e, company_id);
        if storage::pending_admin(&e, company_id).is_none() {
            panic_with_error!(&e, PayrollError::NoPendingAdmin);
        }

        storage::remove_pending_admin(&e, company_id);
        storage::extend_instance(&e);

        AdminProposalCancelled { company_id }.publish(&e);
    }

    /// Completes the pending admin handover. From this call on, `pay` moves
    /// money from the new admin's confidential balance.
    ///
    /// The proposed admin must authorize. It must not be invited to or active
    /// in this company, because the admin is the treasury and the treasury is
    /// never also a worker. A removed worker may become admin. It must be
    /// registered with the token under the company's auditor id, so the
    /// company's accountant keeps reading every payment after the handover.
    ///
    /// Fails with `CompanyNotFound`, `NoPendingAdmin`, `AdminTransferExpired`
    /// if the current ledger is after `live_until_ledger`, `WorkerIsAdmin` if
    /// the proposed admin is invited or active here, `NotRegisteredWithToken`,
    /// or `AuditorMismatch`.
    ///
    /// Emits `AdminChanged`.
    pub fn accept_admin(e: Env, company_id: u64) {
        let mut company = load_company(&e, company_id);
        let pending = storage::pending_admin(&e, company_id)
            .unwrap_or_else(|| panic_with_error!(&e, PayrollError::NoPendingAdmin));
        pending.new_admin.require_auth();
        if e.ledger().sequence() > pending.live_until_ledger {
            panic_with_error!(&e, PayrollError::AdminTransferExpired);
        }
        if let Some(record) = storage::worker_record(&e, company_id, &pending.new_admin) {
            if record.status != WorkerStatus::Removed {
                panic_with_error!(&e, PayrollError::WorkerIsAdmin);
            }
            storage::extend_worker_record(&e, company_id, &pending.new_admin);
        }
        require_registered_under(&e, &pending.new_admin, company.auditor_id);

        let previous_admin = company.admin.clone();
        company.admin = pending.new_admin.clone();
        storage::set_company(&e, company_id, &company);
        storage::remove_pending_admin(&e, company_id);
        storage::extend_instance(&e);

        AdminChanged {
            company_id,
            previous_admin,
            new_admin: pending.new_admin,
        }
        .publish(&e);
    }

    /// Invites `worker` to the company. The worker joins only by calling
    /// `accept_invite` with their own signature. A removed worker may be
    /// invited again.
    ///
    /// The admin must authorize.
    ///
    /// Fails with `CompanyNotFound`, `WorkerIsAdmin` if `worker` is the
    /// admin, or `AlreadyMember` if the worker is already invited or active.
    ///
    /// Emits `WorkerInvited`.
    pub fn invite_worker(e: Env, company_id: u64, worker: Address) {
        let company = load_company_as_admin(&e, company_id);
        if worker == company.admin {
            panic_with_error!(&e, PayrollError::WorkerIsAdmin);
        }
        let on_roster = match storage::worker_record(&e, company_id, &worker) {
            Some(record) if record.status != WorkerStatus::Removed => {
                panic_with_error!(&e, PayrollError::AlreadyMember)
            }
            Some(record) => record.on_roster,
            None => false,
        };

        let record = WorkerRecord {
            status: WorkerStatus::Invited,
            on_roster,
        };
        storage::set_worker_record(&e, company_id, &worker, &record);
        storage::extend_instance(&e);

        WorkerInvited { company_id, worker }.publish(&e);
    }

    /// Withdraws a pending invite before the worker accepts it. The worker's
    /// status becomes `Removed`, so they can be invited again later. The
    /// roster is not touched: a worker who joined before keeps their entry,
    /// and one who never joined never gets one.
    ///
    /// The admin must authorize.
    ///
    /// Fails with `CompanyNotFound`, or `InviteNotFound` if the worker's
    /// status is not `Invited`.
    ///
    /// Emits `InviteRevoked`.
    pub fn revoke_invite(e: Env, company_id: u64, worker: Address) {
        load_company_as_admin(&e, company_id);
        let mut record = match storage::worker_record(&e, company_id, &worker) {
            Some(record) if record.status == WorkerStatus::Invited => record,
            _ => panic_with_error!(&e, PayrollError::InviteNotFound),
        };

        record.status = WorkerStatus::Removed;
        storage::set_worker_record(&e, company_id, &worker, &record);
        storage::extend_instance(&e);

        InviteRevoked { company_id, worker }.publish(&e);
    }

    /// Accepts an invite. The worker becomes active and is appended to the
    /// roster the first time they join.
    ///
    /// `worker` must authorize, must not be the company's current admin, and
    /// must be registered with the token under any auditor id: a worker keeps
    /// their own.
    ///
    /// Fails with `CompanyNotFound`, `WorkerIsAdmin` if `worker` is the
    /// admin, `InviteNotFound` if the worker's status is not `Invited`, or
    /// `NotRegisteredWithToken`.
    ///
    /// Emits `WorkerJoined`.
    pub fn accept_invite(e: Env, company_id: u64, worker: Address) {
        let mut company = load_company(&e, company_id);
        worker.require_auth();
        // Unreachable through invite_worker and accept_admin today. Kept so
        // the treasury can never join its own payroll whatever path led here.
        if worker == company.admin {
            panic_with_error!(&e, PayrollError::WorkerIsAdmin);
        }
        let mut record = match storage::worker_record(&e, company_id, &worker) {
            Some(record) if record.status == WorkerStatus::Invited => record,
            _ => panic_with_error!(&e, PayrollError::InviteNotFound),
        };
        // Only registration matters here, not which auditor id: the worker's
        // own auditor reads what the worker receives.
        registered_auditor_id(&e, &worker);

        if !record.on_roster {
            storage::set_roster_at(&e, company_id, company.roster_len, &worker);
            company.roster_len += 1;
            record.on_roster = true;
        }
        record.status = WorkerStatus::Active;
        company.active_workers += 1;
        storage::set_worker_record(&e, company_id, &worker, &record);
        storage::set_company(&e, company_id, &company);
        storage::extend_instance(&e);

        WorkerJoined { company_id, worker }.publish(&e);
    }

    /// Removes an active worker. They can no longer be paid. Their roster
    /// entry and paid history stay.
    ///
    /// The admin must authorize.
    ///
    /// Fails with `CompanyNotFound`, or `NotActive` if the worker is not
    /// active.
    ///
    /// Emits `WorkerRemoved`.
    pub fn remove_worker(e: Env, company_id: u64, worker: Address) {
        let mut company = load_company_as_admin(&e, company_id);
        let mut record = match storage::worker_record(&e, company_id, &worker) {
            Some(record) if record.status == WorkerStatus::Active => record,
            _ => panic_with_error!(&e, PayrollError::NotActive),
        };

        record.status = WorkerStatus::Removed;
        company.active_workers -= 1;
        storage::set_worker_record(&e, company_id, &worker, &record);
        storage::set_company(&e, company_id, &company);
        storage::extend_instance(&e);

        WorkerRemoved { company_id, worker }.publish(&e);
    }

    /// Opens pay run `run_id` for the company. A run id opens once per
    /// company, ever: a closed run can never be reopened.
    ///
    /// The admin must authorize.
    ///
    /// Fails with `CompanyNotFound`, `RunExists` if this company already used
    /// `run_id`, `LabelInvalid` if `period_label` is empty or longer than 32
    /// bytes, or `ExpectedCountInvalid` unless `expected_count` is between 1
    /// and the number of active workers.
    ///
    /// Emits `RunOpened`.
    pub fn open_run(
        e: Env,
        company_id: u64,
        run_id: u64,
        period_label: String,
        expected_count: u32,
    ) {
        let company = load_company_as_admin(&e, company_id);
        if storage::has_run(&e, company_id, run_id) {
            panic_with_error!(&e, PayrollError::RunExists);
        }
        require_label(&e, &period_label, MAX_PERIOD_LABEL_BYTES);
        if expected_count == 0 || expected_count > company.active_workers {
            panic_with_error!(&e, PayrollError::ExpectedCountInvalid);
        }

        let run = Run {
            status: RunStatus::Open,
            period_label: period_label.clone(),
            expected_count,
            paid_count: 0,
            opened_ledger: e.ledger().sequence(),
        };
        storage::set_run(&e, company_id, run_id, &run);
        storage::extend_instance(&e);

        RunOpened {
            company_id,
            run_id,
            period_label,
            expected_count,
        }
        .publish(&e);
    }

    /// Pays each `(worker, data)` in order with a confidential transfer from
    /// the company's current admin to that worker.
    ///
    /// The admin must authorize. The admin's signature is checked before
    /// anything changes, so the admin's single signed tree is rooted at this
    /// call and covers each nested `confidential_transfer(admin, worker,
    /// data)`. `data` for item k must be proven against the admin's balance
    /// after item k-1, because the token checks each proof against the stored
    /// balance at the moment it runs.
    ///
    /// Each worker's paid flag is set, and the run's count raised and checked,
    /// before the token is called.
    ///
    /// Fails with `CompanyNotFound`, `RunNotFound`, `RunNotOpen`, `NoItems`,
    /// `TooManyItems` above `MAX_BATCH`, `WorkerIsAdmin` if an item names the
    /// admin, `NotActive` if a worker is not active right now, `AlreadyPaid`
    /// if a worker was already paid in this run (including earlier in the same
    /// batch), `ExpectedCountExceeded`, or with the token's own error if a
    /// transfer fails. Any failure undoes the whole call: no flag, no
    /// transfer, no event.
    ///
    /// Emits `PayslipIssued` once per item, right after its transfer.
    pub fn pay(e: Env, company_id: u64, run_id: u64, items: Vec<(Address, Bytes)>) {
        let company = load_company_as_admin(&e, company_id);
        let mut run = storage::run(&e, company_id, run_id)
            .unwrap_or_else(|| panic_with_error!(&e, PayrollError::RunNotFound));
        if run.status != RunStatus::Open {
            panic_with_error!(&e, PayrollError::RunNotOpen);
        }
        let count = items.len();
        if count == 0 {
            panic_with_error!(&e, PayrollError::NoItems);
        }
        if count > MAX_BATCH {
            panic_with_error!(&e, PayrollError::TooManyItems);
        }

        let token = token::Client::new(&e, &storage::token(&e));
        for (worker, data) in items.iter() {
            // accept_admin and accept_invite already keep the admin off the
            // roster; this keeps pay from ever being a transfer to itself.
            if worker == company.admin {
                panic_with_error!(&e, PayrollError::WorkerIsAdmin);
            }
            match storage::worker_record(&e, company_id, &worker) {
                Some(record) if record.status == WorkerStatus::Active => {
                    storage::extend_worker_record(&e, company_id, &worker);
                }
                _ => panic_with_error!(&e, PayrollError::NotActive),
            }
            if storage::is_paid(&e, company_id, run_id, &worker) {
                panic_with_error!(&e, PayrollError::AlreadyPaid);
            }

            storage::set_paid(&e, company_id, run_id, &worker);
            run.paid_count += 1;
            if run.paid_count > run.expected_count {
                panic_with_error!(&e, PayrollError::ExpectedCountExceeded);
            }
            storage::set_run(&e, company_id, run_id, &run);

            token.confidential_transfer(&company.admin, &worker, &data);
            PayslipIssued {
                company_id,
                run_id,
                worker,
            }
            .publish(&e);
        }
        storage::extend_instance(&e);
    }

    /// Closes an open run. A closed run takes no more payments and its id can
    /// never be opened again.
    ///
    /// The admin must authorize.
    ///
    /// Fails with `CompanyNotFound`, `RunNotFound`, or `RunNotOpen` if the run
    /// is already closed.
    ///
    /// Emits `RunClosed` with the number of workers paid.
    pub fn close_run(e: Env, company_id: u64, run_id: u64) {
        load_company_as_admin(&e, company_id);
        let mut run = storage::run(&e, company_id, run_id)
            .unwrap_or_else(|| panic_with_error!(&e, PayrollError::RunNotFound));
        if run.status != RunStatus::Open {
            panic_with_error!(&e, PayrollError::RunNotOpen);
        }

        run.status = RunStatus::Closed;
        storage::set_run(&e, company_id, run_id, &run);
        storage::extend_instance(&e);

        RunClosed {
            company_id,
            run_id,
            paid_count: run.paid_count,
        }
        .publish(&e);
    }

    /// Returns the company. Needs no signature.
    ///
    /// Fails with `CompanyNotFound`.
    pub fn get_company(e: Env, company_id: u64) -> Company {
        load_company(&e, company_id)
    }

    /// Returns one run of one company. Needs no signature.
    ///
    /// Fails with `RunNotFound` if this company never opened `run_id`.
    pub fn get_run(e: Env, company_id: u64, run_id: u64) -> Run {
        storage::run(&e, company_id, run_id)
            .unwrap_or_else(|| panic_with_error!(&e, PayrollError::RunNotFound))
    }

    /// Returns whether `worker` was paid in this company's run `run_id`. Needs
    /// no signature. Unknown companies, runs and workers read as `false`.
    pub fn is_paid(e: Env, company_id: u64, run_id: u64, worker: Address) -> bool {
        storage::is_paid(&e, company_id, run_id, &worker)
    }

    /// Returns the worker's status in the company, or `None` if they were
    /// never invited. Needs no signature.
    pub fn worker_status(e: Env, company_id: u64, worker: Address) -> Option<WorkerStatus> {
        storage::worker_record(&e, company_id, &worker).map(|record| record.status)
    }

    /// Returns up to `limit` roster entries starting at index `start`, in
    /// join order. The roster lists everyone who ever joined, including
    /// removed workers; use `worker_status` for who is active. Needs no
    /// signature.
    ///
    /// Fails with `LimitInvalid` unless `limit` is between 1 and 50, or
    /// `CompanyNotFound`.
    pub fn get_roster(e: Env, company_id: u64, start: u32, limit: u32) -> Vec<Address> {
        if limit == 0 || limit > MAX_ROSTER_PAGE {
            panic_with_error!(&e, PayrollError::LimitInvalid);
        }
        let company = load_company(&e, company_id);
        let end = start.saturating_add(limit).min(company.roster_len);
        let mut page = Vec::new(&e);
        for index in start..end {
            // Every index below roster_len was written in the same call that
            // raised roster_len, so the entry is always there.
            page.push_back(storage::roster_at(&e, company_id, index).unwrap());
        }
        page
    }

    /// Returns the pending admin handover, or `None`. A proposal past its
    /// `live_until_ledger` is still returned until it is replaced, cancelled
    /// or accepted, and accepting it fails. Needs no signature.
    pub fn pending_admin(e: Env, company_id: u64) -> Option<PendingAdmin> {
        storage::pending_admin(&e, company_id)
    }

    /// Returns the confidential token this contract pays through. Needs no
    /// signature.
    pub fn token(e: Env) -> Address {
        storage::token(&e)
    }

    /// Returns how many companies exist, which is also the next company id.
    /// Needs no signature.
    pub fn company_count(e: Env) -> u64 {
        storage::next_company_id(&e)
    }
}

fn load_company(e: &Env, company_id: u64) -> Company {
    storage::company(e, company_id)
        .unwrap_or_else(|| panic_with_error!(e, PayrollError::CompanyNotFound))
}

/// Loads the company for a change only its admin may make. The admin's
/// signature is checked before anything changes, then the company record is
/// extended, because most admin calls read it without writing it.
fn load_company_as_admin(e: &Env, company_id: u64) -> Company {
    let company = load_company(e, company_id);
    company.admin.require_auth();
    storage::extend_company(e, company_id);
    company
}

fn require_label(e: &Env, label: &String, max_bytes: u32) {
    let len = label.len();
    if len == 0 || len > max_bytes {
        panic_with_error!(e, PayrollError::LabelInvalid);
    }
}

/// Reads the auditor id `account` is registered under in the token. Any
/// failure to read the account fails closed as `NotRegisteredWithToken`; for
/// an unregistered account that failure is the token's error 3501.
fn registered_auditor_id(e: &Env, account: &Address) -> u32 {
    let token = token::Client::new(e, &storage::token(e));
    match token.try_confidential_balance(account) {
        Ok(Ok(confidential_account)) => confidential_account.auditor_id,
        _ => panic_with_error!(e, PayrollError::NotRegisteredWithToken),
    }
}

/// Both sides of the comparison come from the chain: the company's stored id
/// and the id the token recorded when the account registered.
fn require_registered_under(e: &Env, account: &Address, auditor_id: u32) {
    if registered_auditor_id(e, account) != auditor_id {
        panic_with_error!(e, PayrollError::AuditorMismatch);
    }
}

use soroban_sdk::{
    contract, contractclient, contractimpl, panic_with_error, Address, Bytes, Env, String, Vec,
};

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

/// The one kalypso-auditor function the payroll calls, declared by hand so
/// the payroll's build never imports the registry's wasm. The signature
/// matches `AuditorRegistry::owner_of` in packages/contracts/auditor. Only
/// the generated client is used; nothing implements the trait, hence the
/// dead-code allowance.
#[allow(dead_code)]
#[contractclient(name = "AuditorRegistryClient")]
pub trait AuditorRegistry {
    fn owner_of(e: Env, auditor_id: u32) -> Address;
}

#[contract]
pub struct Payroll;

#[contractimpl]
impl Payroll {
    /// Binds the contract to one confidential token and one auditor registry
    /// for its whole life.
    ///
    /// `auditor_registry` must be the registry the token reads auditor keys
    /// from. The token publishes no getter for it, so this cannot be checked
    /// here; the deploy passes the address the token was built with.
    ///
    /// Runs once, inside the deploy transaction, so nobody can call it later
    /// and no signature is checked. Emits no event.
    pub fn __constructor(e: Env, token: Address, auditor_registry: Address) {
        storage::set_token(&e, &token);
        storage::set_auditor_registry(&e, &auditor_registry);
        storage::extend_instance(&e);
    }

    /// Signs up a new company and returns its id. Ids start at 0 and count up.
    ///
    /// `admin` must authorize. `admin` becomes the company's treasury, so it
    /// must already be registered with the token, and the auditor id it is
    /// registered under must equal `auditor_id`. The auditor registry must
    /// then say `accountant` owns `auditor_id`, so a treasury bound to an id
    /// somebody else registered first is refused. `accountant` does not sign
    /// and is stored in the new `Company.accountant` field.
    ///
    /// Fails with `LabelInvalid` if `label` is empty or longer than 64 bytes,
    /// `NotRegisteredWithToken` if the token has no account for `admin`,
    /// `TokenUnavailable` if the token cannot be read for any other reason,
    /// `AuditorMismatch` if the registered auditor id differs,
    /// `AuditorNotOwnedByAccountant` if the registry names another owner for
    /// `auditor_id`, does not know the id, or cannot be read, and
    /// `CounterOverflow` if every company id has been used.
    ///
    /// Emits `CompanyCreated`, which carries `accountant`.
    pub fn create_company(
        e: Env,
        admin: Address,
        accountant: Address,
        auditor_id: u32,
        label: String,
    ) -> u64 {
        admin.require_auth();
        require_label(&e, &label, MAX_COMPANY_LABEL_BYTES);
        require_registered_under(&e, &admin, auditor_id);
        require_owned_by(&e, auditor_id, &accountant);

        let company_id = storage::next_company_id(&e);
        let next_company_id = company_id
            .checked_add(1)
            .unwrap_or_else(|| panic_with_error!(&e, PayrollError::CounterOverflow));
        storage::set_next_company_id(&e, next_company_id);
        let company = Company {
            admin: admin.clone(),
            accountant: accountant.clone(),
            auditor_id,
            label: label.clone(),
            created_ledger: e.ledger().sequence(),
            active_workers: 0,
            roster_len: 0,
            runs_opened: 0,
            admin_changes: 0,
        };
        storage::set_company(&e, company_id, &company);
        storage::extend_instance(&e);

        CompanyCreated {
            company_id,
            admin,
            accountant,
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
    /// `live_until_ledger` is not after the current ledger or is past the
    /// furthest ledger the network lets a storage entry live to
    /// (`max_live_until_ledger`).
    ///
    /// Emits `AdminProposed`.
    pub fn propose_admin(e: Env, company_id: u64, new_admin: Address, live_until_ledger: u32) {
        load_company_as_admin(&e, company_id);
        // The upper bound matches the auditor registry's: an offer can be
        // stored for its whole window, and none stays acceptable for years.
        if live_until_ledger <= e.ledger().sequence()
            || live_until_ledger > e.ledger().max_live_until_ledger()
        {
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
    /// Raises the company's `admin_changes` by one, so a history reader can
    /// check it holds every `AdminChanged` event.
    ///
    /// Fails with `CompanyNotFound`, `NoPendingAdmin`, `AdminTransferExpired`
    /// if the current ledger is after `live_until_ledger`, `WorkerIsAdmin` if
    /// the proposed admin is invited or active here, `NotRegisteredWithToken`,
    /// `TokenUnavailable` if the token cannot be read for any other reason,
    /// `AuditorMismatch`, or `CounterOverflow` if `admin_changes` is already
    /// at its limit.
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
        company.admin_changes = company
            .admin_changes
            .checked_add(1)
            .unwrap_or_else(|| panic_with_error!(&e, PayrollError::CounterOverflow));
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
    /// roster the first time they join. That first join also raises the
    /// worker's `memberships_of` count by one; rejoining after removal does
    /// not, because the roster entry already exists.
    ///
    /// `worker` must authorize, must not be the company's current admin, and
    /// must be registered with the token under any auditor id: a worker keeps
    /// their own.
    ///
    /// Fails with `CompanyNotFound`, `WorkerIsAdmin` if `worker` is the
    /// admin, `InviteNotFound` if the worker's status is not `Invited`,
    /// `NotRegisteredWithToken`, `TokenUnavailable` if the token cannot be
    /// read for any other reason, or `CounterOverflow` if the roster length,
    /// the active worker count or the worker's membership count is already
    /// at its limit.
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
            company.roster_len = company
                .roster_len
                .checked_add(1)
                .unwrap_or_else(|| panic_with_error!(&e, PayrollError::CounterOverflow));
            let memberships = storage::memberships(&e, &worker)
                .checked_add(1)
                .unwrap_or_else(|| panic_with_error!(&e, PayrollError::CounterOverflow));
            storage::set_memberships(&e, &worker, memberships);
            record.on_roster = true;
        }
        record.status = WorkerStatus::Active;
        company.active_workers = company
            .active_workers
            .checked_add(1)
            .unwrap_or_else(|| panic_with_error!(&e, PayrollError::CounterOverflow));
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
    /// Fails with `CompanyNotFound`, `NotActive` if the worker is not active,
    /// or `CounterOverflow` if the active worker count is already zero, which
    /// no sequence of public calls produces.
    ///
    /// Emits `WorkerRemoved`.
    pub fn remove_worker(e: Env, company_id: u64, worker: Address) {
        let mut company = load_company_as_admin(&e, company_id);
        let mut record = match storage::worker_record(&e, company_id, &worker) {
            Some(record) if record.status == WorkerStatus::Active => record,
            _ => panic_with_error!(&e, PayrollError::NotActive),
        };

        record.status = WorkerStatus::Removed;
        company.active_workers = company
            .active_workers
            .checked_sub(1)
            .unwrap_or_else(|| panic_with_error!(&e, PayrollError::CounterOverflow));
        storage::set_worker_record(&e, company_id, &worker, &record);
        storage::set_company(&e, company_id, &company);
        storage::extend_instance(&e);

        WorkerRemoved { company_id, worker }.publish(&e);
    }

    /// Opens pay run `run_id` for the company. A run id opens once per
    /// company, ever: a closed run can never be reopened. Raises the
    /// company's `runs_opened` by one, so a history reader can check it
    /// holds every `RunOpened` event even though run ids are not listed.
    ///
    /// The admin must authorize.
    ///
    /// Fails with `CompanyNotFound`, `RunExists` if this company already used
    /// `run_id`, `LabelInvalid` if `period_label` is empty or longer than 32
    /// bytes, `ExpectedCountInvalid` unless `expected_count` is between 1
    /// and the number of active workers, or `CounterOverflow` if
    /// `runs_opened` is already at its limit.
    ///
    /// Emits `RunOpened`.
    pub fn open_run(
        e: Env,
        company_id: u64,
        run_id: u64,
        period_label: String,
        expected_count: u32,
    ) {
        let mut company = load_company_as_admin(&e, company_id);
        if storage::has_run(&e, company_id, run_id) {
            panic_with_error!(&e, PayrollError::RunExists);
        }
        require_label(&e, &period_label, MAX_PERIOD_LABEL_BYTES);
        if expected_count == 0 || expected_count > company.active_workers {
            panic_with_error!(&e, PayrollError::ExpectedCountInvalid);
        }
        company.runs_opened = company
            .runs_opened
            .checked_add(1)
            .unwrap_or_else(|| panic_with_error!(&e, PayrollError::CounterOverflow));

        let run = Run {
            status: RunStatus::Open,
            period_label: period_label.clone(),
            expected_count,
            paid_count: 0,
            opened_ledger: e.ledger().sequence(),
        };
        storage::set_run(&e, company_id, run_id, &run);
        storage::set_company(&e, company_id, &company);
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
    /// batch), `CounterOverflow` if the run's paid count is already at its
    /// limit, `ExpectedCountExceeded`, or with the token's own error if a
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
            run.paid_count = run
                .paid_count
                .checked_add(1)
                .unwrap_or_else(|| panic_with_error!(&e, PayrollError::CounterOverflow));
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

    /// Returns the company, including the `accountant` named at creation.
    /// Needs no signature.
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
    /// Fails with `LimitInvalid` unless `limit` is between 1 and 50,
    /// `CompanyNotFound`, or `MissingRecord` if a roster entry below the
    /// roster length is missing, which no sequence of public calls produces.
    pub fn get_roster(e: Env, company_id: u64, start: u32, limit: u32) -> Vec<Address> {
        if limit == 0 || limit > MAX_ROSTER_PAGE {
            panic_with_error!(&e, PayrollError::LimitInvalid);
        }
        let company = load_company(&e, company_id);
        let end = start.saturating_add(limit).min(company.roster_len);
        let mut page = Vec::new(&e);
        for index in start..end {
            // Every index below roster_len was written in the same call that
            // raised roster_len, so a gap means storage was changed some other
            // way, and the read fails rather than returning a short page.
            let worker = storage::roster_at(&e, company_id, index)
                .unwrap_or_else(|| panic_with_error!(&e, PayrollError::MissingRecord));
            page.push_back(worker);
        }
        page
    }

    /// Returns how many companies `worker` has ever joined, or 0 for a worker
    /// who never joined one. Counted once per company, at the first accepted
    /// invite, and never lowered. A history reader compares it with the
    /// companies it holds for the worker; with each company's `runs_opened`
    /// and `is_paid`, every pay the worker received can then be listed from
    /// the chain alone. Needs no signature.
    pub fn memberships_of(e: Env, worker: Address) -> u32 {
        storage::memberships(&e, &worker)
    }

    /// Returns the pending admin handover, or `None`. A proposal past its
    /// `live_until_ledger` is still returned until it is replaced, cancelled
    /// or accepted, and accepting it fails. Needs no signature.
    pub fn pending_admin(e: Env, company_id: u64) -> Option<PendingAdmin> {
        storage::pending_admin(&e, company_id)
    }

    /// Returns the confidential token this contract pays through. Needs no
    /// signature.
    ///
    /// Fails with `MissingRecord` only if the address the constructor wrote
    /// is gone, which no public call can cause.
    pub fn token(e: Env) -> Address {
        storage::token(&e)
    }

    /// Returns the auditor registry `create_company` asks who owns an
    /// auditor id. Needs no signature.
    ///
    /// Fails with `MissingRecord` only if the address the constructor wrote
    /// is gone, which no public call can cause.
    pub fn auditor_registry(e: Env) -> Address {
        storage::auditor_registry(&e)
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

/// Reads the auditor id `account` is registered under in the token. Every
/// failure refuses the call. Exactly one answer, the token's own
/// AccountNotRegistered (3501), means the account is not registered; any
/// other failure is reported as `TokenUnavailable`, so an outage is never
/// shown to the caller as a missing registration.
fn registered_auditor_id(e: &Env, account: &Address) -> u32 {
    let token = token::Client::new(e, &storage::token(e));
    let not_registered: soroban_sdk::Error =
        token::ConfidentialTokenError::AccountNotRegistered.into();
    match token.try_confidential_balance(account) {
        Ok(Ok(confidential_account)) => confidential_account.auditor_id,
        Err(Ok(error)) if error == not_registered => {
            panic_with_error!(e, PayrollError::NotRegisteredWithToken)
        }
        _ => panic_with_error!(e, PayrollError::TokenUnavailable),
    }
}

/// Both sides of the comparison come from the chain: the company's stored id
/// and the id the token recorded when the account registered.
fn require_registered_under(e: &Env, account: &Address, auditor_id: u32) {
    if registered_auditor_id(e, account) != auditor_id {
        panic_with_error!(e, PayrollError::AuditorMismatch);
    }
}

/// Fails closed: an unknown id, a registry that traps or is missing, and an
/// answer that does not decode as an address are all refused, the same as
/// another owner. Covers who owns the id now; it does not cover a later
/// handover of the id in the registry, which this contract never sees.
fn require_owned_by(e: &Env, auditor_id: u32, accountant: &Address) {
    let registry = AuditorRegistryClient::new(e, &storage::auditor_registry(e));
    match registry.try_owner_of(&auditor_id) {
        Ok(Ok(owner)) if owner == *accountant => {}
        _ => panic_with_error!(e, PayrollError::AuditorNotOwnedByAccountant),
    }
}

use soroban_sdk::contracterror;

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum PayrollError {
    CompanyNotFound = 1,
    /// The token answered that it has no confidential account for this
    /// address: the token's own error 3501.
    NotRegisteredWithToken = 2,
    /// The account is registered with the token under a different auditor id
    /// than the company's.
    AuditorMismatch = 3,
    /// A label is empty or longer than its cap.
    LabelInvalid = 4,
    /// The address is the company's admin, or would become admin while
    /// invited to or active in the company. The treasury is never also a
    /// worker, so `pay` can never move money from the admin to itself.
    WorkerIsAdmin = 5,
    /// The worker is already invited to or active in this company.
    AlreadyMember = 6,
    InviteNotFound = 7,
    /// The worker is not active in this company right now.
    NotActive = 8,
    /// This run id was already used by this company, open or closed.
    RunExists = 9,
    RunNotFound = 10,
    RunNotOpen = 11,
    NoItems = 12,
    TooManyItems = 13,
    AlreadyPaid = 14,
    ExpectedCountExceeded = 15,
    ExpectedCountInvalid = 16,
    NoPendingAdmin = 17,
    AdminTransferExpired = 18,
    InvalidLiveUntil = 19,
    LimitInvalid = 20,
    /// A counter would go past the largest value its type holds, or below
    /// zero: the next company id, a company's roster length, active worker
    /// count, runs opened or admin changes, a run's paid count, or a
    /// worker's membership count. The call is refused rather than letting
    /// the counter wrap.
    CounterOverflow = 21,
    /// A record the contract always writes before it reads it is missing:
    /// the token or registry address set by the constructor, or a roster
    /// entry below the company's roster length. No public function can cause
    /// this; it fails closed if storage is ever not what the code expects.
    MissingRecord = 22,
    /// The auditor registry does not say the named accountant owns the
    /// auditor id, or could not be read. Both refuse the call, so a treasury
    /// bound to an id somebody else took first can never found a company.
    AuditorNotOwnedByAccountant = 23,
    /// The token could not be read for a reason other than an unregistered
    /// account: it trapped, has no `confidential_balance`, or answered with
    /// something that does not decode. The call is refused, and the caller
    /// can tell an outage from a missing registration.
    TokenUnavailable = 24,
}

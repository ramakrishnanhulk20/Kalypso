use soroban_sdk::contracterror;

/// Errors raised by the registry itself. Codes start at 100 so they never
/// collide with OpenZeppelin's auditor errors (3300 to 3303), which the
/// registry also raises unchanged for key validation and unknown ids in
/// `get_key`.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum RegistryError {
    /// No auditor key has been registered under this id.
    UnknownAuditor = 100,
    /// The id has no owner handover in progress.
    NoPendingOwner = 101,
    /// The handover deadline has passed.
    OwnerTransferExpired = 102,
    /// The handover deadline is not after the current ledger, or is further
    /// out than the network lets a storage entry live.
    InvalidLiveUntil = 103,
    /// The proposed new owner already owns the id.
    SameOwner = 104,
    /// Every id the counter can count has been handed out, so there is no
    /// next id. The call is refused rather than letting the counter wrap back
    /// to an id that already has an owner.
    CounterOverflow = 105,
}

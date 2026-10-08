// Rules the prove command applies to history it has already read, kept apart from the reads so
// they can be checked offline on made-up histories.

/**
 * How many times `treasury` spent from its confidential balance in `events` (core HistoryEvents):
 * every transfer and withdraw from it, and every transfer or withdraw the history could not decode
 * that names it first. That is the set core's audit gives a verdict to (balanceChain in
 * packages/core/src/payslips/accountant.ts), so under a key that opens nothing each one is marked
 * undecryptable, whichever payroll contract sent it.
 */
export function treasurySpendCount(events, treasury) {
  const spendName = (name) => name === "transfer" || name === "withdraw";
  return events.filter(
    (e) =>
      (e.kind === "token" && spendName(e.event.type) && e.event.from === treasury) ||
      (e.kind === "undecodable" && spendName(e.name) && e.parties?.[0] === treasury),
  ).length;
}

/**
 * The archive's start rule (isDeployEvent in packages/server/src/archive/ingest.ts): history read
 * from the token's deploy ledger starts at the token's birth only when the first token event in it
 * is in that ledger and comes from the token's own deploy transaction. Which event the constructor
 * emitted first does not matter.
 */
export function startsAtDeploy(first, deployTx) {
  return first !== null && first !== undefined && first.ledger === deployTx.ledger && first.txHash === deployTx.hash;
}

import { RowChip } from "../row-chip";

export const PUBLIC_ACCOUNTANT_TITLE = "This company uses the published demo accountant key, so anyone can read its amounts.";

const PLAIN_CASE = { textTransform: "none", letterSpacing: "0.04em" } as const;

// A company set up before the wizard refused published ids can still be opened by id, so its
// dashboard says plainly that its books are open to anyone.
export function AccountantFact({ accountantId, publiclyReadable }: { accountantId: number | null; publiclyReadable: boolean }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="t-label" style={PLAIN_CASE}>
        {accountantId === null ? <span className="skeleton-bar inline-block w-24 align-middle" /> : `Accountant id ${accountantId}`}
      </span>
      {publiclyReadable ? (
        <span title={PUBLIC_ACCOUNTANT_TITLE} data-public-accountant>
          <RowChip tone="wait">Publicly readable</RowChip>
        </span>
      ) : null}
    </span>
  );
}

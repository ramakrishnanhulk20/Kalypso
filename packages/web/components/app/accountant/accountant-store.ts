// The accountant id this wallet registered, kept in this browser. It is a hint only: registering
// again with it makes the lib check the registry first and send nothing when it still holds.

const keyOf = (address: string) => `kalypso/accountant/v1/${address}`;
const MAX_U32 = 0xffff_ffff;

export function readAccountantId(address: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(keyOf(address)) ?? "null");
    const id = (parsed as { id?: unknown } | null)?.id;
    return typeof id === "number" && Number.isSafeInteger(id) && id >= 0 && id <= MAX_U32 ? id : undefined;
  } catch {
    return undefined;
  }
}

export function saveAccountantId(address: string, id: number): void {
  try {
    window.localStorage.setItem(keyOf(address), JSON.stringify({ id }));
  } catch {
    /* the id is still shown on screen for this visit */
  }
}

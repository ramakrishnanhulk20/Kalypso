import { MAX_COMPANY_LABEL_BYTES } from "@kalypso/core";

export const MAX_LABEL_BYTES: number = MAX_COMPANY_LABEL_BYTES;

// The contract limits the name in UTF-8 bytes, so the counter counts bytes. For plain letters
// and digits a byte is a character.
export function labelBytes(name: string): number {
  return new TextEncoder().encode(name.trim()).length;
}

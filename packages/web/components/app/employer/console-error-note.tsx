"use client";

import { useTranslations } from "next-intl";
import { ErrorNote } from "@/components/app/error-note";
import type { ShownError } from "@/components/app/errors";
import { TestFundsCard } from "@/components/app/test-funds-card";
import { useWallet } from "@/components/app/wallet-session";

// The lib's English sentences for these two send a person to friendbot, the Laboratory and the
// DEX. The page words them its own way, so English shows the same sentence the other languages do.
const PAGE_WORDS: ReadonlySet<string> = new Set(["ACCOUNT_NOT_FOUND", "USDC_SHORT"]);

// An error note for the employer console. A wallet whose account is not on testnet yet gets the
// test money card right under the sentence that says so, so the next step is one click away.
export function ConsoleErrorNote({ error }: { error: ShownError }) {
  const t = useTranslations("errors.console");
  const wallet = useWallet();
  const own = error.family === "console" && error.code !== undefined && PAGE_WORDS.has(error.code);
  const accountMissing = error.family === "console" && error.code === "ACCOUNT_NOT_FOUND";
  return (
    <>
      <ErrorNote error={own ? { ...error, message: t(error.code as string) } : error} />
      {accountMissing ? (
        <div className="mt-4 w-full max-w-[640px]">
          <TestFundsCard address={wallet.address} assets={["xlm", "usdc"]} wallet={wallet} open anchor={false} />
        </div>
      ) : null}
    </>
  );
}

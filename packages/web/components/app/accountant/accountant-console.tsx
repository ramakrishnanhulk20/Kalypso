"use client";

import { useTranslations } from "next-intl";
import { TestFundsCard, useFundsNeed } from "@/components/app/test-funds-card";
import { useWallet } from "@/components/app/wallet-session";
import { BooksPanel } from "./books-panel";
import { KeyPanel } from "./key-panel";

export function AccountantConsole() {
  const t = useTranslations("accountant");
  const wallet = useWallet();
  const fundsNeeded = useFundsNeed(wallet.address, ["xlm"]);
  return (
    <>
      <h1 className="sr-only">{t("srTitle")}</h1>
      {fundsNeeded === null ? null : (
        <div className="mb-10 w-full max-w-[640px]">
          <TestFundsCard address={wallet.address} assets={["xlm"]} open={fundsNeeded} />
        </div>
      )}
      <KeyPanel />
      <BooksPanel />
    </>
  );
}

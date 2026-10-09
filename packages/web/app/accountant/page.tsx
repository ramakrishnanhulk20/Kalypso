import type { Metadata } from "next";
import { AppHeader } from "@/components/app-header";
import { AccountantConsole } from "@/components/app/accountant/accountant-console";
import { WalletGate } from "@/components/app/wallet-gate";
import { WalletSession } from "@/components/app/wallet-session";

export const metadata: Metadata = {
  title: "Accountant · Kalypso",
  description: "Register your accountant key, then open and export the books of a private payroll.",
};

export default function AccountantPage() {
  return (
    <WalletSession>
      <AppHeader />
      <main className="bg-ink" style={{ padding: "8vh 4vw 14vh" }}>
        <div className="mx-auto w-full max-w-[1240px]" style={{ minHeight: "60vh" }}>
          <WalletGate
            heading="Keep the books on private payroll."
            paragraph="Connect Freighter on Testnet. Your key is derived from your wallet's signature, so it never leaves this browser and the same wallet always rebuilds it."
          >
            <AccountantConsole />
          </WalletGate>
        </div>
      </main>
    </WalletSession>
  );
}

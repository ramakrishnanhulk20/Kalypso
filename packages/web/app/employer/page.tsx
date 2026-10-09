import type { Metadata } from "next";
import { AppHeader } from "@/components/app-header";
import { EmployerConsole } from "@/components/app/employer/employer-console";
import { WalletGate } from "@/components/app/wallet-gate";
import { WalletSession } from "@/components/app/wallet-session";

export const metadata: Metadata = {
  title: "Employer · Kalypso",
  description: "Set up a company, fund its sealed treasury, invite your team and pay a month from a spreadsheet.",
};

export default function EmployerPage() {
  return (
    <WalletSession>
      <AppHeader />
      <main className="bg-ink" style={{ padding: "8vh 4vw 14vh" }}>
        <div className="mx-auto w-full max-w-[1240px]" style={{ minHeight: "60vh" }}>
          <WalletGate
            heading="Pay your team privately."
            paragraph="Connect Freighter on Testnet. Your wallet signs every payment; Kalypso never holds your keys."
          >
            <EmployerConsole />
          </WalletGate>
        </div>
      </main>
    </WalletSession>
  );
}

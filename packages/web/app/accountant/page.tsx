import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { AppHeader } from "@/components/app-header";
import { AccountantConsole } from "@/components/app/accountant/accountant-console";
import { WalletGate } from "@/components/app/wallet-gate";
import { WalletSession } from "@/components/app/wallet-session";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("metadata.accountant");
  return { title: t("title"), description: t("description") };
}

export default async function AccountantPage() {
  const t = await getTranslations("accountant");
  return (
    <WalletSession>
      <AppHeader />
      <main className="bg-canvas" style={{ padding: "8vh 4vw 14vh" }}>
        <div className="mx-auto w-full max-w-[1240px]" style={{ minHeight: "60vh" }}>
          <WalletGate heading={t("gateHeading")} paragraph={t("gateText")}>
            <AccountantConsole />
          </WalletGate>
        </div>
      </main>
    </WalletSession>
  );
}

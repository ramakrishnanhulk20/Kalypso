import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { AppHeader } from "@/components/app-header";
import { EmployerConsole } from "@/components/app/employer/employer-console";
import { WalletGate } from "@/components/app/wallet-gate";
import { WalletSession } from "@/components/app/wallet-session";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("metadata.employer");
  return { title: t("title"), description: t("description") };
}

export default async function EmployerPage() {
  const t = await getTranslations("employer");
  return (
    <WalletSession>
      <AppHeader />
      <main className="bg-canvas" style={{ padding: "8vh 4vw 14vh" }}>
        <div className="mx-auto w-full max-w-[1240px]" style={{ minHeight: "60vh" }}>
          <WalletGate heading={t("gateHeading")} paragraph={t("gateText")}>
            <EmployerConsole />
          </WalletGate>
        </div>
      </main>
    </WalletSession>
  );
}

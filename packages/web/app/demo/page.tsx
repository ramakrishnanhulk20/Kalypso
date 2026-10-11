import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { AppHeader } from "@/components/app-header";
import { DemoApp } from "@/components/demo/demo-app";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("metadata.sandbox");
  return { title: t("title"), description: t("description") };
}

export default function DemoPage() {
  return (
    <>
      <AppHeader />
      <main className="bg-canvas" style={{ padding: "10vh 4vw 14vh" }}>
        <DemoApp />
      </main>
    </>
  );
}

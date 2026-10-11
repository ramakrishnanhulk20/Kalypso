import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { DemoApp } from "@/components/demo/demo-app";
import { SiteNav } from "@/components/site-nav/site-nav";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("metadata.sandbox");
  return { title: t("title"), description: t("description") };
}

export default function DemoPage() {
  return (
    <>
      <SiteNav />
      <main className="bg-canvas" style={{ padding: "10vh 4vw 14vh" }}>
        <DemoApp />
      </main>
    </>
  );
}

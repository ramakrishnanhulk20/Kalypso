import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { WorkerPortal } from "@/components/app/worker/worker-portal";
import { SiteNav } from "@/components/site-nav/site-nav";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("metadata.worker");
  return { title: t("title"), description: t("description") };
}

export default function WorkerPage() {
  return (
    <>
      <SiteNav />
      <main className="bg-canvas px-5 pb-[14vh] pt-[8vh] md:px-[4vw] md:py-[6vh]">
        <div className="mx-auto w-full max-w-[720px]" style={{ minHeight: "60vh" }}>
          <WorkerPortal />
        </div>
      </main>
    </>
  );
}

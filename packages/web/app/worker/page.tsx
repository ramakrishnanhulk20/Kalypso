import type { Metadata } from "next";
import { AppHeader } from "@/components/app-header";
import { WorkerPortal } from "@/components/app/worker/worker-portal";

export const metadata: Metadata = {
  title: "Your pay · Kalypso",
  description: "Sign in with Face ID, read your payslips and cash out. Your pay stays sealed on Stellar until your own key opens it.",
};

export default function WorkerPage() {
  return (
    <>
      <AppHeader />
      <main className="bg-ink px-5 pb-[14vh] pt-[8vh] md:px-[4vw] md:py-[6vh]">
        <div className="mx-auto w-full max-w-[720px]" style={{ minHeight: "60vh" }}>
          <WorkerPortal />
        </div>
      </main>
    </>
  );
}

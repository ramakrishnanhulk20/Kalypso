import type { Metadata } from "next";
import { AppHeader } from "@/components/app-header";
import { DemoApp } from "@/components/demo/demo-app";

export const metadata: Metadata = {
  title: "Sandbox · Kalypso",
  description: "Run a real Kalypso payroll on Stellar testnet in your browser, no wallet needed.",
};

export default function DemoPage() {
  return (
    <>
      <AppHeader />
      <main className="bg-ink" style={{ padding: "10vh 4vw 14vh" }}>
        <DemoApp />
      </main>
    </>
  );
}

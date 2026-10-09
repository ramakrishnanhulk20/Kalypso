import type { Metadata } from "next";
import { KeyLens } from "@/components/key-lens/key-lens";
import { CheckUs } from "@/components/landing/check-us";
import { OneRun } from "@/components/landing/one-run";
import { SiteFooter } from "@/components/landing/site-footer";
import { ThreeKeys } from "@/components/landing/three-keys";
import { PosterHero } from "@/components/poster-hero";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function Lab() {
  return (
    <main>
      <PosterHero />
      <KeyLens />
      <OneRun />
      <ThreeKeys />
      <CheckUs />
      <SiteFooter />
    </main>
  );
}

import { KeyLens } from "@/components/key-lens/key-lens";
import { CheckUs } from "@/components/landing/check-us";
import { OneRun } from "@/components/landing/one-run";
import { SiteFooter } from "@/components/landing/site-footer";
import { ThreeKeys } from "@/components/landing/three-keys";
import { PosterHero } from "@/components/poster-hero";

export default function Home() {
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

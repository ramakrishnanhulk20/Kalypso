"use client";

import { useLocale, useTranslations } from "next-intl";
import { ChainFeed } from "./chain-feed";
import { LiveLine } from "./live-line";
import { liveSentence, progressFraction, stepNumber, timeLeftLabel } from "./run-state";
import type { RunState } from "./run-state";
import { ShotList } from "./shot-list";
import { SHOT_COUNT, titleOf } from "./shots";
import { useNow } from "./use-now";

const PLAIN_CASE = { textTransform: "none", letterSpacing: "0.04em" } as const;

type RunViewProps = {
  run: RunState;
  onResume: () => void;
  onTryAgain: () => void;
  onStartOver: () => void;
};

export function RunView({ run, onResume, onTryAgain, onStartOver }: RunViewProps) {
  const t = useTranslations("sandbox.run");
  const shots = useTranslations("sandbox.shots");
  const progress = useTranslations("sandbox.progress");
  const common = useTranslations("common");
  const locale = useLocale();
  const now = useNow(run.running);
  const stopped = run.error !== null;
  const paused = !run.running && !stopped;

  const headline = stopped
    ? t("stoppedAt", { step: titleOf(shots, run.failedStep ?? "keys") })
    : liveSentence(run, locale, progress) || (paused ? t("saved") : "");

  return (
    <section>
      <h1 className="sr-only">{t("srTitle")}</h1>
      <LiveLine text={headline} />
      <p className="t-label mt-4" style={PLAIN_CASE}>
        {t("stepOf", { n: stepNumber(run), total: SHOT_COUNT, left: timeLeftLabel(t, run.frontier) })}
      </p>

      {stopped ? (
        <p role="alert" className="mt-5 max-w-[40rem] font-sans text-base text-fail">
          {run.error}
        </p>
      ) : null}
      {stopped || paused ? (
        <div className="mt-5 flex flex-wrap gap-3">
          <button type="button" className="btn-seal" onClick={stopped ? onTryAgain : onResume}>
            {stopped ? common("tryAgain") : common("resume")}
          </button>
          <button type="button" className="btn-ghost" onClick={onStartOver}>
            {common("startOver")}
          </button>
        </div>
      ) : null}

      <div aria-hidden="true" className="mt-8 h-[2px] w-full" style={{ background: "color-mix(in srgb, var(--color-fg) 8%, transparent)" }}>
        <div
          className="h-full bg-seal transition-[width] duration-[600ms] ease-linear motion-reduce:transition-none"
          style={{ width: `${progressFraction(run, now) * 100}%` }}
        />
      </div>

      <div className="mt-10 grid grid-cols-1 gap-y-12 lg:grid-cols-12 lg:gap-x-[4vw]">
        <div className="min-w-0 lg:col-span-7">
          <ShotList run={run} now={now} />
        </div>
        <div className="min-w-0 lg:col-span-4 lg:col-start-9">
          <ChainFeed entries={run.feed} />
        </div>
      </div>
    </section>
  );
}

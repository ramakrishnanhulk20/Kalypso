"use client";

import { useEffect, useRef, useState } from "react";
import { shortId } from "@/lib/ledger";
import { ATTACK_RUN_URL, EXPLORER_URL } from "@/lib/links";
import { contracts, payrollVersion } from "@/lib/stack";

// Each command shows as typed lines and copies as one line, so a pasted
// command never carries the continuation backslashes.
const COMMANDS: { shown: string[]; copied: string }[] = [
  {
    shown: ["npm run check:testnet"],
    copied: "npm run check:testnet",
  },
  {
    shown: ["npm run prove:testnet"],
    copied: "npm run prove:testnet",
  },
  {
    shown: [
      "stellar contract info build \\",
      `    --id ${contracts.payroll} \\`,
      "    --network testnet",
    ],
    copied: `stellar contract info build --id ${contracts.payroll} --network testnet`,
  },
];

const COPIED_FOR_MS = 1200;

function CopyIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4.5" y="4.5" width="7" height="7" rx="1.5" />
      <path d="M9.5 4.5V3a1.5 1.5 0 0 0-1.5-1.5H3A1.5 1.5 0 0 0 1.5 3v5A1.5 1.5 0 0 0 3 9.5h1.5" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2.5 7.5 5.5 10.5 11.5 3.5" />
    </svg>
  );
}

function CommandLine({
  shown,
  command,
  onCopied,
}: {
  shown: string[];
  command: string;
  onCopied: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(0);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
    } catch {
      return;
    }
    setCopied(true);
    onCopied();
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), COPIED_FOR_MS);
  };

  return (
    <div className="group relative">
      <code className="block w-max whitespace-pre text-paper">
        <span className="select-none">$ </span>
        {shown.join("\n")}
      </code>
      <button
        type="button"
        onClick={copy}
        aria-label={`Copy command: ${command}`}
        className="absolute right-0 top-0 flex h-7 w-7 items-center justify-center rounded-[8px] bg-[#0f0b0a] text-muted opacity-0 transition-[opacity,color,background-color] duration-200 hover:bg-[#211d1c] hover:text-paper focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </button>
    </div>
  );
}

const CLAIMS = [
  {
    heading: "Nobody can change the rules.",
    text: "The verifier that checks every proof has no admin left, and neither of our contracts has an admin or an upgrade path. The check reads it from the chain.",
  },
  {
    heading: "The code on chain is this code.",
    text: `GitHub builds each release and signs a build attestation. The payroll contract running on testnet traces back to release v${payrollVersion} of the public repository.`,
    contract: true,
  },
  {
    heading: "Attack it.",
    text: "One command attacks the live showcase company the ways the threat model names, and prints what stopped each attack.",
  },
];

const PLAIN_CASE = { textTransform: "none", letterSpacing: "0.04em" } as const;

export function CheckUs() {
  const [announcement, setAnnouncement] = useState("");
  const clearTimer = useRef(0);

  useEffect(() => () => window.clearTimeout(clearTimer.current), []);

  const announce = () => {
    setAnnouncement("Copied");
    window.clearTimeout(clearTimer.current);
    clearTimer.current = window.setTimeout(
      () => setAnnouncement(""),
      COPIED_FOR_MS,
    );
  };

  return (
    <section className="relative bg-ink" style={{ padding: "18vh 4vw" }}>
      <div>
        <p className="t-label">Don&apos;t trust us</p>
        <h2 className="t-h2 mt-4">Check it yourself.</h2>
        <p className="t-lead mt-[22px]">
          Everything Kalypso claims can be checked from a terminal against the
          live testnet contracts.
        </p>
      </div>

      <div className="mt-[10vh] grid grid-cols-1 gap-y-14 lg:grid-cols-12 lg:gap-x-[4vw]">
        <div className="min-w-0 lg:col-span-6">
          {CLAIMS.map((claim, index) => (
            <div
              key={claim.heading}
              className={`py-8 ${index === 0 ? "pt-0" : "border-t border-line"}`}
            >
              <h3
                className="font-display text-[1.5rem] font-medium text-paper"
                style={{ fontVariationSettings: '"opsz" 36' }}
              >
                {claim.heading}
              </h3>
              <p className="mt-3 max-w-[32rem] font-sans text-[1rem] text-muted">
                {claim.text}
              </p>
              {claim.contract ? (
                <a
                  href={`${EXPLORER_URL}/contract/${contracts.payroll}`}
                  target="_blank"
                  rel="noopener"
                  aria-label={`Payroll contract ${shortId(contracts.payroll)} on Stellar Expert`}
                  className="link-draw mt-4 font-mono text-[0.875rem]"
                >
                  {shortId(contracts.payroll)}
                </a>
              ) : null}
            </div>
          ))}
        </div>

        <div className="min-w-0 lg:col-span-6">
          <div
            role="group"
            aria-label="Commands to run"
            className="overflow-x-auto rounded-card border border-line p-[22px] font-mono text-[0.875rem] leading-[1.7]"
            style={{ background: "#0f0b0a" }}
          >
            <div className="mb-4 flex items-center justify-between">
              <div aria-hidden="true" className="flex gap-2">
                {[0, 1, 2].map((dot) => (
                  <span
                    key={dot}
                    className="h-2 w-2 rounded-full"
                    style={{ background: "rgba(242,236,230,0.15)" }}
                  />
                ))}
              </div>
              <span className="t-label">testnet</span>
            </div>
            <div className="flex flex-col gap-1">
              {COMMANDS.map((entry) => (
                <CommandLine
                  key={entry.copied}
                  shown={entry.shown}
                  command={entry.copied}
                  onCopied={announce}
                />
              ))}
            </div>
          </div>

          <p className="t-label mt-4" style={PLAIN_CASE}>
            Last full run:{" "}
            <a
              href={ATTACK_RUN_URL}
              target="_blank"
              rel="noopener"
              className="link-draw font-mono"
            >
              docs/security/attack-run.md
            </a>
          </p>
        </div>
      </div>

      <div role="status" className="sr-only">
        {announcement}
      </div>
    </section>
  );
}

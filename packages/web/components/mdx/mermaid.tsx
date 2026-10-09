"use client";

import { useEffect, useId, useState } from "react";

type MermaidProps = { chart: string };

type DrawState =
  | { kind: "drawing" }
  | { kind: "done"; svg: string; width: number }
  | { kind: "failed" };

let initialised = false;
// Mermaid keeps one scratch element per render call, and overlapping calls on a
// page with three diagrams corrupt each other. Draw one at a time.
let queue: Promise<unknown> = Promise.resolve();

async function draw(id: string, chart: string, fontFamily: string) {
  const { default: mermaid } = await import("mermaid");
  if (!initialised) {
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: "base",
      themeVariables: {
        background: "#1d1716",
        primaryColor: "#261e1c",
        primaryTextColor: "#f2ece6",
        primaryBorderColor: "rgba(242,236,230,0.25)",
        lineColor: "#a79c94",
        secondaryColor: "#1d1716",
        tertiaryColor: "#15100f",
        fontFamily,
        fontSize: "14px",
        noteBkgColor: "#261e1c",
        noteTextColor: "#f2ece6",
        actorBkg: "#261e1c",
        actorBorder: "rgba(242,236,230,0.25)",
        actorTextColor: "#f2ece6",
        signalColor: "#a79c94",
        signalTextColor: "#f2ece6",
      },
    });
    initialised = true;
  }
  return mermaid.render(id, chart);
}

function naturalWidth(svg: string) {
  const match = /viewBox="[-\d.]+ [-\d.]+ ([\d.]+) [\d.]+"/.exec(svg);
  return match ? Math.ceil(Number(match[1])) : 0;
}

export function Mermaid({ chart }: MermaidProps) {
  const id = `mermaid-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [state, setState] = useState<DrawState>({ kind: "drawing" });

  useEffect(() => {
    let cancelled = false;
    const fontFamily = getComputedStyle(document.body).fontFamily;
    const run = queue.then(() => draw(id, chart, fontFamily));
    queue = run.catch(() => undefined);
    run.then(
      ({ svg }) => {
        if (!cancelled) setState({ kind: "done", svg, width: naturalWidth(svg) });
      },
      () => {
        // A failed render leaves its error drawing attached to the page body.
        document.getElementById(`d${id}`)?.remove();
        if (!cancelled) setState({ kind: "failed" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [id, chart]);

  if (state.kind === "failed") {
    return (
      <div className="kalypso-mermaid not-prose" tabIndex={0} role="region" aria-label="Diagram source">
        <pre className="kalypso-mermaid-source">{chart}</pre>
      </div>
    );
  }

  return (
    <div
      className="kalypso-mermaid not-prose"
      tabIndex={0}
      role="region"
      aria-label="Diagram"
      aria-busy={state.kind === "drawing"}
      data-state={state.kind}
      style={
        state.kind === "done"
          ? ({ "--diagram-w": `${state.width}px` } as React.CSSProperties)
          : undefined
      }
      dangerouslySetInnerHTML={
        state.kind === "done" ? { __html: state.svg } : undefined
      }
    />
  );
}

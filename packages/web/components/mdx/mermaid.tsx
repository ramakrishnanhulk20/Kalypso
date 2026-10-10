"use client";

import { useEffect, useId, useRef, useState } from "react";
import { showsRightFade } from "./diagram-fade";

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

function ExpandIcon() {
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
      <path d="M8.5 1.5h4v4M5.5 12.5h-4v-4M12.5 1.5 8 6M1.5 12.5 6 8" />
    </svg>
  );
}

export function Mermaid({ chart }: MermaidProps) {
  const id = `mermaid-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [state, setState] = useState<DrawState>({ kind: "drawing" });
  const [fade, setFade] = useState(false);
  const [fullSize, setFullSize] = useState(false);
  const frameRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

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

  const drawn = state.kind === "done";
  useEffect(() => {
    const frame = frameRef.current;
    const box = boxRef.current;
    if (!drawn || !frame || !box) return;
    const update = () => {
      setFade(showsRightFade(box));
      // The fade stops above a sideways scrollbar instead of covering it.
      frame.style.setProperty("--diagram-scrollbar", `${Math.max(0, box.offsetHeight - box.clientHeight - 1)}px`);
    };
    update();
    box.addEventListener("scroll", update, { passive: true });
    const resize = new ResizeObserver(update);
    resize.observe(box);
    const svg = box.querySelector("svg");
    if (svg) resize.observe(svg);
    return () => {
      box.removeEventListener("scroll", update);
      resize.disconnect();
    };
  }, [drawn]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (fullSize && dialog && !dialog.open) dialog.showModal();
  }, [fullSize]);

  if (state.kind === "failed") {
    return (
      <div className="kalypso-diagram not-prose">
        <div className="kalypso-mermaid" tabIndex={0} role="region" aria-label="Diagram source">
          <pre className="kalypso-mermaid-source">{chart}</pre>
        </div>
      </div>
    );
  }

  const natural = { "--diagram-w": `${state.kind === "done" ? state.width : 0}px` } as React.CSSProperties;

  return (
    <div ref={frameRef} className="kalypso-diagram not-prose">
      <div
        ref={boxRef}
        className="kalypso-mermaid"
        tabIndex={0}
        role="region"
        aria-label="Diagram"
        aria-busy={state.kind === "drawing"}
        data-state={state.kind}
        style={state.kind === "done" ? natural : undefined}
        dangerouslySetInnerHTML={state.kind === "done" ? { __html: state.svg } : undefined}
      />
      {fade ? <div aria-hidden="true" className="kalypso-mermaid-fade" /> : null}
      {state.kind === "done" ? (
        <>
          <button ref={openerRef} type="button" className="btn-ghost kalypso-diagram-button" onClick={() => setFullSize(true)}>
            <ExpandIcon />
            Full size
          </button>
          {/* The drawn markup is reused as it is, never rendered again. Its ids repeat while this is open,
              and every reference inside it resolves to the identical element on the page. */}
          <dialog
            ref={dialogRef}
            className="kalypso-diagram-full"
            aria-label="Diagram, full size"
            data-lenis-prevent
            onClose={() => {
              setFullSize(false);
              openerRef.current?.focus();
            }}
          >
            {fullSize ? (
              <>
                <button type="button" className="btn-ghost kalypso-diagram-close" onClick={() => dialogRef.current?.close()}>
                  Close
                </button>
                <div className="kalypso-diagram-full-stage" style={natural} dangerouslySetInnerHTML={{ __html: state.svg }} />
              </>
            ) : null}
          </dialog>
        </>
      ) : null}
    </div>
  );
}

"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { tokenValue } from "@/lib/theme/palette";
import { useThemeClass } from "@/lib/theme/use-theme-class";
import { showsRightFade } from "./diagram-fade";

type MermaidProps = { chart: string };

type DrawState =
  | { kind: "drawing" }
  | { kind: "done"; svg: string; width: number }
  | { kind: "failed" };

// Mermaid keeps one scratch element per render call, and overlapping calls on a
// page with three diagrams corrupt each other. Draw one at a time.
let queue: Promise<unknown> = Promise.resolve();

// The diagram colours are the page's own tokens, read at draw time so a theme change redraws
// the diagram in the new theme.
function themeVariables(fontFamily: string) {
  const raised = tokenValue("--raised");
  const raised2 = tokenValue("--raised-2");
  const fg = tokenValue("--fg");
  const muted = tokenValue("--muted");
  const line = tokenValue("--line-strong");
  return {
    background: raised,
    primaryColor: raised2,
    primaryTextColor: fg,
    primaryBorderColor: line,
    lineColor: muted,
    secondaryColor: raised,
    tertiaryColor: tokenValue("--canvas"),
    fontFamily,
    fontSize: "14px",
    noteBkgColor: raised2,
    noteTextColor: fg,
    actorBkg: raised2,
    actorBorder: line,
    actorTextColor: fg,
    signalColor: muted,
    signalTextColor: fg,
  };
}

async function draw(id: string, chart: string, fontFamily: string) {
  const { default: mermaid } = await import("mermaid");
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    themeVariables: themeVariables(fontFamily),
  });
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
  const t = useTranslations("docs.diagram");
  const baseId = `mermaid-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const themeClass = useThemeClass();
  const [state, setState] = useState<DrawState>({ kind: "drawing" });
  const [fade, setFade] = useState(false);
  const [fullSize, setFullSize] = useState(false);
  const frameRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const renders = useRef(0);

  useEffect(() => {
    let cancelled = false;
    // Each draw gets its own id: Mermaid refuses to draw twice into one.
    renders.current += 1;
    const id = `${baseId}-${renders.current}`;
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
    // themeClass is here so the diagram is drawn again in the new theme's colours. It is the
    // class on <html>, not the provider's state, so the tokens the draw reads are the new ones.
  }, [baseId, chart, themeClass]);

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
        <div className="kalypso-mermaid" tabIndex={0} role="region" aria-label={t("source")}>
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
        aria-label={t("label")}
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
            {t("fullSize")}
          </button>
          {/* The drawn markup is reused as it is, never rendered again. Its ids repeat while this is open,
              and every reference inside it resolves to the identical element on the page. */}
          <dialog
            ref={dialogRef}
            className="kalypso-diagram-full"
            aria-label={t("fullSizeLabel")}
            data-lenis-prevent
            onClose={() => {
              setFullSize(false);
              openerRef.current?.focus();
            }}
          >
            {fullSize ? (
              <>
                <button type="button" className="btn-ghost kalypso-diagram-close" onClick={() => dialogRef.current?.close()}>
                  {t("close")}
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

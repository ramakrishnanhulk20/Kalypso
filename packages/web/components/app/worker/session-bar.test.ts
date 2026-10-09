// Covers the session bar's one rule (C51): a worker's address is shown and offered for copying only
// once it is proven; until then neither the address nor a copy button is drawn.
// Does NOT cover: how the bar looks in a browser, or the proof itself (lib/worker tests).
import { isValidElement } from "react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { CopyButton } from "../copy-button";
import { SessionBar } from "./session-bar";

const ADDRESS = "CB6BSQ3PXPCF7EM3HGUXBWJBQCLZ3GVYV3C5QH5LKFEDNAHC7URRS6NL";

// Walks the element tree without calling components, keeping the text and every element's props.
function seen(node: ReactNode, into: { text: string; elements: { type: unknown; props: Record<string, unknown> }[] } = { text: "", elements: [] }) {
  if (typeof node === "string" || typeof node === "number") into.text += String(node);
  else if (Array.isArray(node)) node.forEach((child: ReactNode) => seen(child, into));
  else if (isValidElement<Record<string, unknown> & { children?: ReactNode }>(node)) {
    into.elements.push({ type: node.type, props: node.props });
    seen(node.props.children, into);
  }
  return into;
}

describe("SessionBar", () => {
  it("draws no address and no copy button before the address is proven", () => {
    const shown = seen(SessionBar({ address: null, onSignOut: () => undefined }));
    expect(shown.elements.some((e) => e.type === CopyButton)).toBe(false);
    expect(shown.text).toContain("Wallet not set up yet");
    expect(shown.text).not.toMatch(/CB6B/);
  });

  it("shows the proven address and copies exactly it", () => {
    const shown = seen(SessionBar({ address: ADDRESS, onSignOut: () => undefined }));
    expect(shown.text).toContain("CB6B");
    expect(shown.elements.find((e) => e.type === CopyButton)?.props.text).toBe(ADDRESS);
  });
});

// Covers the session bar's one rule (C51): a worker's address is shown and offered for copying only
// once it is proven; until then neither the address nor a copy button is drawn.
// Does NOT cover: how the bar looks in a browser, or the proof itself (lib/worker tests).
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { renderEnglish, textOf } from "../../../test/i18n";
import { SessionBar } from "./session-bar";

const ADDRESS = "CB6BSQ3PXPCF7EM3HGUXBWJBQCLZ3GVYV3C5QH5LKFEDNAHC7URRS6NL";

describe("SessionBar", () => {
  it("draws no address and no copy button before the address is proven", () => {
    const markup = renderEnglish(createElement(SessionBar, { address: null, onSignOut: () => undefined }));
    expect(markup).not.toContain("Copy your address");
    expect(textOf(markup)).toContain("Wallet not set up yet");
    expect(textOf(markup)).not.toMatch(/CB6B/);
  });

  it("shows the proven address and copies exactly it", () => {
    const markup = renderEnglish(createElement(SessionBar, { address: ADDRESS, onSignOut: () => undefined }));
    expect(textOf(markup)).toContain("CB6B");
    expect(markup).toContain('aria-label="Copy your address"');
  });
});

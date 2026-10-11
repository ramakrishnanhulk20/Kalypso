// Covers that nothing in components/ or lib/ calls the browser's confirm(), alert() or prompt(),
// written as window.confirm(...) or as a bare call, and that the in-page question that replaces them
// shows the question with its confirm button in the seal style and its cancel button in the ghost
// style. A bare call is only flagged in a file that does not declare a function of that name itself
// (lib/worker has its own confirm). Does NOT cover test files, which may hold such text as data, or
// the clicks, focus and Esc of the in-page question (the W11 screenshot run drives those).
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { renderEnglish, textOf } from "../../test/i18n";
import { ConfirmAsk } from "../app/employer/inline-confirm";

const ROOT = path.resolve(import.meta.dirname, "../..");
const NAMES = ["confirm", "alert", "prompt"] as const;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

// Comments may name the dialogs in prose; only code counts.
const withoutComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

function nativeDialogCalls(file: string): string[] {
  const code = withoutComments(readFileSync(file, "utf8"));
  const found: string[] = [];
  for (const name of NAMES) {
    if (new RegExp(`\\b(?:window|globalThis|self)\\s*\\.\\s*${name}\\s*\\(`).test(code)) found.push(`window.${name}()`);
    const declared = new RegExp(`\\bfunction\\s+${name}\\b|\\b(?:const|let|var)\\s+${name}\\b|import\\s*(?:type\\s*)?\\{[^}]*\\b${name}\\b[^}]*\\}`).test(code);
    if (!declared && new RegExp(`(?<![\\w$.])${name}\\s*\\(`).test(code)) found.push(`${name}()`);
  }
  return found;
}

describe("browser dialogs", () => {
  it("are never called from components or lib", () => {
    const files = [...sourceFiles(path.join(ROOT, "components")), ...sourceFiles(path.join(ROOT, "lib"))];
    expect(files.length).toBeGreaterThan(50);
    const calls = files.flatMap((file) => nativeDialogCalls(file).map((call) => `${path.relative(ROOT, file)}: ${call}`));
    expect(calls).toEqual([]);
  });

  it("would be caught, both written out and bare", () => {
    expect(new RegExp(`\\b(?:window|globalThis|self)\\s*\\.\\s*confirm\\s*\\(`).test(`if (window.confirm("x")) go();`)).toBe(true);
    expect(new RegExp(`(?<![\\w$.])alert\\s*\\(`).test(`alert("x");`)).toBe(true);
    expect(new RegExp(`(?<![\\w$.])alert\\s*\\(`).test(`lens.alert("x");`)).toBe(false);
  });
});

describe("the in-page question", () => {
  it("asks with a seal confirm button and a ghost cancel button", () => {
    const markup = renderEnglish(
      createElement(ConfirmAsk, {
        question: "Start a new sandbox? This forgets the one you ran.",
        confirmLabel: "Start over",
        cancelLabel: "Keep it",
        onConfirm: () => undefined,
        onCancel: () => undefined,
      }),
    );
    expect(markup).toContain('role="group"');
    expect(textOf(markup)).toBe("Start a new sandbox? This forgets the one you ran.Start overKeep it");
    expect(markup).toMatch(/<button type="button" class="btn-seal"[^>]*>Start over<\/button>/);
    expect(markup).toMatch(/<button type="button" class="btn-ghost"[^>]*>Keep it<\/button>/);
  });
});

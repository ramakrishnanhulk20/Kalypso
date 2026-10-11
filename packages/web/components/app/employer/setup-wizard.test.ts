// Covers the wizard's accountant choice: two cards in one radio group, "I'll keep my own books"
// chosen by default with the seal border, and the wizard opening on the own-books step (its key
// button, none of the id and address fields). Does NOT cover clicking between the cards or the
// steps that follow (the live testnet run in scratchpad/w10 drives those), or keepOwnBooks itself
// (lib/accountant/own-books.test.ts).
import { createElement } from "react";
import { describe, expect, it } from "vitest";
import { Keypair } from "../../../lib/sandbox/sdk";
import { throwawayWallet } from "../../../lib/wallet/throwaway";
import { renderEnglish, textOf } from "../../../test/i18n";
import { WalletProvider } from "../wallet-session";
import { BooksChoiceCards, SetupWizard } from "./setup-wizard";

const OWN = "I'll keep my own books";
const OWN_TEXT = "Use this same wallet as your accountant. Freighter asks you to sign twice to make the key, then to approve one transaction.";
const OTHER = "Someone else keeps the books";

/** The radio input for one choice. */
function radio(markup: string, choice: string): string {
  return markup.match(new RegExp(`<input type="radio"[^>]*value="${choice}"[^>]*>`))?.[0] ?? "";
}

/** The opening tag of the card face for one choice. */
function face(markup: string, choice: string): string {
  const start = markup.indexOf(`<span data-choice="${choice}"`);
  return start < 0 ? "" : markup.slice(start, markup.indexOf(">", start) + 1);
}

describe("the accountant choice", () => {
  it("is one radio group of two cards, with the chosen card in the seal border", () => {
    const markup = renderEnglish(createElement(BooksChoiceCards, { value: "own", onChange: () => undefined }));
    expect(markup).toContain('role="radiogroup"');
    expect(markup.match(/<input type="radio"[^>]*name="accountant-choice"/g)).toHaveLength(2);
    expect(radio(markup, "own")).toContain('checked=""');
    expect(radio(markup, "other")).not.toContain("checked");
    expect(face(markup, "own")).toContain("border-seal-hi");
    expect(face(markup, "other")).not.toContain("border-seal-hi");
    expect(face(markup, "other")).toContain("border-line");
    expect(face(markup, "own")).toContain("rounded-card");
    expect(textOf(markup)).toBe(`${OWN}${OWN_TEXT}${OTHER}`);

    const other = renderEnglish(createElement(BooksChoiceCards, { value: "other", onChange: () => undefined }));
    expect(radio(other, "other")).toContain('checked=""');
    expect(radio(other, "own")).not.toContain("checked");
    expect(face(other, "other")).toContain("border-seal-hi");
    expect(face(other, "own")).not.toContain("border-seal-hi");
  });

  it("disables own books, saying why, when the treasury already names an outside accountant", () => {
    const markup = renderEnglish(createElement(BooksChoiceCards, { value: "other", onChange: () => undefined, ownTaken: true }));
    expect(radio(markup, "own")).toContain('disabled=""');
    expect(radio(markup, "other")).not.toContain("disabled");
    expect(textOf(markup)).toContain(
      "This wallet's payroll account already names an outside accountant, so every company you pay from it shares that accountant. Use another wallet to keep your own books.",
    );
    expect(textOf(markup)).not.toContain(OWN_TEXT);
  });

  it("opens on keeping your own books, with the key button and no id or address fields", () => {
    const wallet = throwawayWallet(Keypair.random());
    const markup = renderEnglish(createElement(WalletProvider, { wallet, children: createElement(SetupWizard, { onCreated: () => undefined }) }));
    expect(radio(markup, "own")).toContain('checked=""');
    expect(textOf(markup)).toContain("Make my accountant key");
    expect(textOf(markup)).not.toContain("Accountant id");
    expect(textOf(markup)).not.toContain("Accountant address");
    expect(textOf(markup)).not.toContain("Confirmation code");
  });
});

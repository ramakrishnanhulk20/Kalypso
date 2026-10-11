// Covers what the test money card shows before anything is clicked: the folded card is only the
// "Need free test money?" button, the open card says every line of its copy word for word, shows
// one row per asset asked for (the accountant gets test XLM only), carries the #test-funds anchor
// with its scroll margin, and a copy shown under an error leaves the anchor to the first card. Also
// covers when a paid claim may say the money arrived: only once the card's own balance read shows
// at least the payout more than before (C55), looking again while the read trails the chain.
// Does NOT cover a claim itself (lib/faucet.test.ts covers the client, and the live run covers the
// route), the trustline step, or how the card looks in a browser.
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { renderEnglish, textOf } from "../../test/i18n";
import { shortId } from "../../lib/ledger";
import en from "../../messages/en.json";
import { CONFIRMING_AFTER_MS, TestFundsCard, UnconfirmedNote, balanceShowing, withConfirmingLabel } from "./test-funds-card";

const ADDRESS = "GBSDDY2NMUMLVTXGTKJ2R7JBJDRWG2NJN6J7ZHLZHT6NJID6ZEYFGKSK";
const render = (props: { assets: ("xlm" | "usdc")[]; open: boolean; anchor?: boolean }) =>
  renderEnglish(createElement(TestFundsCard, { address: ADDRESS, ...props }));

describe("TestFundsCard", () => {
  it("is only a text button while folded", () => {
    const markup = render({ assets: ["xlm", "usdc"], open: false });
    expect(textOf(markup)).toBe("Need free test money?");
    expect(markup).toContain('id="test-funds"');
    expect(markup).toContain("link-draw");
    expect(markup).not.toContain("<section");
  });

  it("says its copy word for word when open for an employer", () => {
    const text = textOf(render({ assets: ["xlm", "usdc"], open: true }));
    expect(text).toBe(
      "Test money" +
        "Get free test money" +
        "Kalypso runs on Stellar's test network, where money is free and has no value. Get what you need in one click." +
        "Test XLM" +
        "Pays the network's tiny fees." +
        "Get 100 test XLM" +
        "Test USDC" +
        "What you pay your team with." +
        "Get 100 test USDC",
    );
  });

  it("gives an accountant the test XLM row only", () => {
    const text = textOf(render({ assets: ["xlm"], open: true }));
    expect(text).toContain("Get 100 test XLM");
    expect(text).not.toContain("USDC");
  });

  it("is the anchor for #test-funds, below the fixed nav, in the card's own surface", () => {
    const markup = render({ assets: ["xlm", "usdc"], open: true });
    expect(markup).toContain('id="test-funds"');
    expect(markup).toContain("scroll-margin-top:96px");
    expect(markup).toContain("rounded-card border border-line bg-raised p-6");
  });

  it("leaves the anchor to the first card when it is a copy under an error", () => {
    const markup = render({ assets: ["xlm", "usdc"], open: true, anchor: false });
    expect(markup).not.toContain('id="test-funds"');
    expect(textOf(markup)).toContain("Get free test money");
  });

  it("says an unconfirmed payout may still arrive, and links its transaction to check", () => {
    const hash = "ab".repeat(32);
    const markup = renderEnglish(createElement(UnconfirmedNote, { hash }));
    expect(textOf(markup)).toBe(
      "Your test money was sent, but the network hasn't confirmed it yet. It may still arrive within a minute; check your wallet before asking again." + shortId(hash),
    );
    expect(markup).toContain(`/tx/${hash}"`);
    expect(markup).toContain('role="status"');
  });

  it("says it is waiting for the network once a claim has run 10 s, and never after the claim ends", async () => {
    vi.useFakeTimers();
    try {
      const sentences = { sending: "sending", confirming: "confirming" };
      const seen: string[] = [];
      let finish: (value: string) => void = () => undefined;
      const slow = withConfirmingLabel((p) => seen.push(p.sentence), sentences, () => new Promise<string>((resolve) => (finish = resolve)));
      await vi.advanceTimersByTimeAsync(CONFIRMING_AFTER_MS - 1);
      expect(seen).toEqual(["sending"]);
      await vi.advanceTimersByTimeAsync(1);
      expect(seen).toEqual(["sending", "confirming"]);
      finish("paid");
      expect(await slow).toBe("paid");

      const quickSeen: string[] = [];
      expect(await withConfirmingLabel((p) => quickSeen.push(p.sentence), sentences, async () => "paid")).toBe("paid");
      await vi.advanceTimersByTimeAsync(CONFIRMING_AFTER_MS * 2);
      expect(quickSeen).toEqual(["sending"]);
      expect(CONFIRMING_AFTER_MS).toBe(10_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays out of the way of the long dash", () => {
    expect(render({ assets: ["xlm", "usdc"], open: true }).includes(String.fromCharCode(0x2014))).toBe(false);
  });
});

describe("balanceShowing", () => {
  const HUNDRED = 1_000_000_000n;
  const reads = (...answers: (bigint | null | Error)[]) => {
    let i = 0;
    return async () => {
      const answer = answers[Math.min(i++, answers.length - 1)];
      if (answer instanceof Error) throw answer;
      return answer as bigint | null;
    };
  };
  const noWait = async () => undefined;

  it("gives the balance once the read shows the payout, counting a missing account or line as zero", async () => {
    expect(await balanceShowing(reads(HUNDRED), null, HUNDRED, noWait)).toBe(HUNDRED);
    expect(await balanceShowing(reads(5n * HUNDRED), 4n * HUNDRED, HUNDRED, noWait)).toBe(5n * HUNDRED);
  });

  it("looks again while the read trails the chain, and a failed read is just one look", async () => {
    expect(await balanceShowing(reads(null, new Error("down"), 3n * HUNDRED), 2n * HUNDRED, HUNDRED, noWait)).toBe(3n * HUNDRED);
  });

  it("says nothing arrived when the funds never show, so the screen shows the unconfirmed note", async () => {
    expect(await balanceShowing(reads(4n * HUNDRED), 4n * HUNDRED, HUNDRED, noWait)).toBeNull();
    expect(await balanceShowing(reads(null), null, HUNDRED, noWait)).toBeNull();
    expect(await balanceShowing(reads(new Error("down")), null, HUNDRED, noWait, 3)).toBeNull();
  });

  it("names the balance it read in the success line", () => {
    expect(en.testFunds.xlm.added).toBe("Added {amount} test XLM. Your wallet now holds {balance} XLM.");
    expect(en.testFunds.usdc.added).toBe("Added {amount} test USDC. Your wallet now holds {balance} USDC.");
  });
});

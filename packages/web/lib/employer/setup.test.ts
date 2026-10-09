// Covers the refusal of a published demo accountant id in checkAccountant and setUpCompany: it
// comes before any registry read, any wallet signature and any transaction, with the exact
// sentence, and an id that is not published still goes on to the registry read. Does NOT cover the
// rest of the set-up (registry ownership, token registration, create_company), which the live
// wizard and core's own tests exercise, or ids published outside core's PUBLISHED_DEMO_AUDITOR_IDS.
import { beforeEach, describe, expect, it, vi } from "vitest";
import showcase from "../../../contracts/deployments/showcase-testnet.json";
import { keyHex } from "../accountant/key";
import { auditorPublicKey } from "../sandbox/accounts";
import { sandboxConfig } from "../sandbox/config";
import { Keypair } from "../sandbox/sdk";
import { throwawayWallet } from "../wallet/throwaway";
import type { ConsoleContext } from "./context";

const holder = vi.hoisted(() => ({ ctx: undefined as unknown }));
vi.mock("./context", async (importOriginal) => ({ ...(await importOriginal<typeof import("./context")>()), consoleContext: () => holder.ctx }));

const { checkAccountant, isPublishedDemoAccountant, setUpCompany } = await import("./setup");

const config = sandboxConfig();
const DEMO_ID = showcase.accountant.auditorId;
const DEMO_ACCOUNTANT = showcase.accountant.account;
const REFUSAL =
  "This accountant id is Kalypso's public demo key: anyone can read payroll under it. Ask your accountant to register their own key and use that id.";
const REACHED_REGISTRY = "reached the registry read";

function fakeContext() {
  const port = {
    read: vi.fn(async () => {
      throw new Error(REACHED_REGISTRY);
    }),
    simulate: vi.fn(),
    submit: vi.fn(),
    waitFor: vi.fn(),
    sourceAccount: vi.fn(),
    latestLedger: vi.fn(),
  };
  const ledger = { xlmBalance: vi.fn(async () => 10_000_0000000n), usdcBalance: vi.fn(async () => 0n) };
  const events = { ledgerWindow: vi.fn(), contractEvents: vi.fn() };
  const prover = vi.fn();
  const ctx = {
    config,
    port,
    events,
    txSource: undefined as never,
    ledger,
    history: undefined as never,
    store: undefined as never,
    text: undefined as never,
    prover,
    wait: async () => undefined,
  } as unknown as ConsoleContext;
  return { ctx, port, ledger, events, prover };
}

let chain: ReturnType<typeof fakeContext>;
beforeEach(() => {
  chain = fakeContext();
  holder.ctx = chain.ctx;
});

describe("isPublishedDemoAccountant", () => {
  it("names the showcase's accountant id in the console's registry and nothing else", () => {
    expect(DEMO_ID).toBe(5);
    expect(isPublishedDemoAccountant(config.contracts.auditor, DEMO_ID)).toBe(true);
    expect(isPublishedDemoAccountant(` ${config.contracts.auditor} `, DEMO_ID)).toBe(true);
    expect(isPublishedDemoAccountant(config.contracts.auditor, DEMO_ID + 1)).toBe(false);
    expect(isPublishedDemoAccountant(config.contracts.payroll, DEMO_ID)).toBe(false);
    expect(() => isPublishedDemoAccountant("not an address", DEMO_ID)).toThrow();
  });
});

describe("checkAccountant", () => {
  it("refuses the published demo id with the showcase's own accountant before reading the registry", async () => {
    const refused = checkAccountant({ accountantId: DEMO_ID, accountant: DEMO_ACCOUNTANT });
    await expect(refused).rejects.toMatchObject({ name: "ConsoleError", code: "DEMO_ACCOUNTANT", message: REFUSAL });
    expect(chain.port.read).not.toHaveBeenCalled();
  });

  it("still reads the registry for an id that is not published", async () => {
    await expect(checkAccountant({ accountantId: DEMO_ID + 1, accountant: DEMO_ACCOUNTANT })).rejects.toThrow(REACHED_REGISTRY);
    expect(chain.port.read).toHaveBeenCalled();
  });
});

describe("setUpCompany", () => {
  it("refuses the published demo id before any read, signature or transaction", async () => {
    const wallet = throwawayWallet(Keypair.random());
    const signMessage = vi.spyOn(wallet, "signMessage");
    const signTransaction = vi.spyOn(wallet, "signTransaction");
    const refused = setUpCompany(wallet, {
      accountantId: DEMO_ID,
      accountant: DEMO_ACCOUNTANT,
      accountantKeyHex: keyHex(auditorPublicKey(11n)),
      label: "Test Co",
    });
    await expect(refused).rejects.toMatchObject({ name: "ConsoleError", code: "DEMO_ACCOUNTANT", message: REFUSAL });
    expect(signMessage).not.toHaveBeenCalled();
    expect(signTransaction).not.toHaveBeenCalled();
    for (const call of [chain.port.read, chain.port.simulate, chain.port.submit, chain.ledger.xlmBalance, chain.events.ledgerWindow, chain.prover]) {
      expect(call).not.toHaveBeenCalled();
    }
  });
});

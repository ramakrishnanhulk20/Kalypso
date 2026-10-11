// Covers when the dashboard may say "You keep your own books": only when the registry, read now,
// names the connected wallet as the owner of the company's accountant id. A company whose recorded
// accountant is its admin, but whose id now belongs to someone else, gets no line, and neither does
// one whose owner cannot be read. Does NOT cover the dashboard's layout or the live registry.
import type { Company } from "@kalypso/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "../../../lib/sandbox/sdk";
import { throwawayWallet } from "../../../lib/wallet/throwaway";

const holder = vi.hoisted(() => ({ owner: undefined as unknown as () => Promise<string>, asked: [] as number[] }));
vi.mock("@/components/app/loaders", () => ({
  loadEmployer: async () => ({ consoleContext: () => ({ port: {}, config: { contracts: { auditor: "CREGISTRY" } } }) }),
}));
vi.mock("@kalypso/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@kalypso/core")>()),
  getOwnerOf: async (_port: unknown, _registry: string, id: number) => {
    holder.asked.push(id);
    return holder.owner();
  },
}));

const { keepsOwnBooks } = await import("./company-read");

const wallet = throwawayWallet(Keypair.random());
const company = (accountant: string): Company =>
  ({ admin: wallet.address, accountant, auditorId: 147, label: "W10 Studio" }) as unknown as Company;

beforeEach(() => {
  holder.asked = [];
});

describe("keepsOwnBooks", () => {
  it("is true when the registry names this wallet as the id's owner now", async () => {
    holder.owner = async () => wallet.address;
    expect(await keepsOwnBooks(wallet, company(wallet.address))).toBe(true);
    expect(holder.asked).toEqual([147]);
  });

  it("is false when the company recorded its admin as accountant but the id now belongs to someone else", async () => {
    holder.owner = async () => Keypair.random().publicKey();
    expect(await keepsOwnBooks(wallet, company(wallet.address))).toBe(false);
  });

  it("is false when the owner cannot be read", async () => {
    holder.owner = () => Promise.reject(new Error("RPC down"));
    expect(await keepsOwnBooks(wallet, company(wallet.address))).toBe(false);
  });
});

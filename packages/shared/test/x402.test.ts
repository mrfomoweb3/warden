import { describe, expect, it } from "vitest";
import { checkPayment, type PaymentRequirements } from "../src/x402.js";

const payTo = "0x" + "d".repeat(64);
const req: PaymentRequirements = {
  scheme: "exact",
  network: "sui-testnet",
  maxAmountRequired: "2000000",
  resource: "search:/search",
  description: "",
  mimeType: "application/json",
  payTo,
  maxTimeoutSeconds: 120,
  asset: "0x2::sui::SUI",
  extra: { settlement: "sui-tx", nonce: "n1", issuedAtMs: 1_000_000 },
};

const tx = (over: Record<string, unknown> = {}) => ({
  digest: "D",
  timestampMs: "1001000",
  transaction: { data: { sender: "0xagent" } },
  effects: { status: { status: "success" } },
  balanceChanges: [{ owner: { AddressOwner: payTo }, coinType: "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI", amount: "2000000" }],
  events: [{ type: "0xpkg::vault::Spent", parsedJson: { memo: Array.from(new TextEncoder().encode("n1")) } }],
  ...over,
});

describe("checkPayment", () => {
  it("accepts a vault payment bound to the nonce", () => {
    expect(checkPayment(tx(), req, "n1")).toMatchObject({ ok: true, payer: "0xagent", amount: 2_000_000n });
  });

  it("rejects underpayment, wrong nonce, failed and stale txs", () => {
    expect(checkPayment(tx({ balanceChanges: [] }), req, "n1").ok).toBe(false);
    expect(checkPayment(tx(), req, "other")).toMatchObject({ ok: false, reason: expect.stringMatching(/memo/) });
    expect(checkPayment(tx({ effects: { status: { status: "failure", error: "abort" } } }), req, "n1").ok).toBe(false);
    expect(checkPayment(tx({ timestampMs: "1" }), req, "n1")).toMatchObject({ ok: false, reason: expect.stringMatching(/predates/) });
  });

  it("accepts a plain transfer (Warden's own wallet) without a Spent event", () => {
    expect(checkPayment(tx({ events: [] }), req, "n1").ok).toBe(true);
  });
});

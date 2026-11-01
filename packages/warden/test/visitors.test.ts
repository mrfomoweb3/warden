import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { describe, expect, it } from "vitest";
import { mockBackend } from "../src/memory/walrus.js";
import type { PaymentContext } from "../src/policy/context.js";
import { PatternIntentParser } from "../src/policy/parser.js";
import { VisitorRegistry, type VisitorDeps } from "../src/visitors.js";
import { addr } from "./helpers.js";

const DIGEST = "8dW4mZ3pQk1xYbN7vR2sT9uLcF6hJ5aE3gK8nP2qW4rX";

function ctx(over: Partial<PaymentContext> = {}): PaymentContext {
  return {
    event: { kind: "spent", agentId: addr(1), label: "researcher", recipient: addr(9), amount: 2_000_000n, memo: "", spentToday: 1n, ts: 1_000, digest: DIGEST, seq: "0" },
    agent: "researcher",
    counterparty: addr(9),
    amountUsd: 0.002,
    dailyUsd: 0.5,
    isNewCounterparty: true,
    baselineDailyUsd: 0.4,
    daysObserved: 3,
    velocity: () => 1,
    rejectedCount: () => 0,
    ...over,
  };
}

function make(over: Partial<VisitorDeps> = {}) {
  const sent: { chatId: string; text: string; buttons?: { text: string; data: string }[][] }[] = [];
  let now = Date.UTC(2026, 10, 1, 9);
  const visitors = new VisitorRegistry({
    stateFile: null,
    parser: new PatternIntentParser(),
    agents: () => ["pricebot", "researcher"],
    send: async (chatId, text, buttons) => void sent.push({ chatId, text, buttons }),
    network: "testnet",
    siteUrl: "https://example.test",
    secret: "test-secret",
    log: () => {},
    now: () => now,
    ...over,
  });
  visitors.setBotUsername("warden_test_bot");
  return { visitors, sent, tick: (ms: number) => (now += ms) };
}

async function signIn(visitors: VisitorRegistry, kp = new Ed25519Keypair()) {
  const { message } = visitors.issueNonce();
  const { signature } = await kp.signPersonalMessage(new TextEncoder().encode(message));
  const out = await visitors.login(kp.toSuiAddress(), message, signature);
  return { ...out, kp, message, signature, visitor: visitors.authenticate(out.token) };
}

/** Links a Telegram chat the way the bot does: /start with the code from the deep link. */
async function link(visitors: VisitorRegistry, v: ReturnType<VisitorRegistry["authenticate"]>, chatId = "777") {
  const code = visitors.telegramLink(v).link.split("start=")[1]!;
  return visitors.handleChat(chatId, { kind: "text", text: `/start ${code}` });
}

describe("visitor sign-in", () => {
  it("accepts a signed nonce once, and issues a session token", async () => {
    const t = make();
    const s = await signIn(t.visitors);
    expect(s.visitor.address).toBe(s.kp.toSuiAddress());
    // The same nonce can't be replayed.
    await expect(t.visitors.login(s.kp.toSuiAddress(), s.message, s.signature)).rejects.toThrow(/expired/);
  });

  it("rejects a signature from another address", async () => {
    const t = make();
    const { message } = t.visitors.issueNonce();
    const { signature } = await new Ed25519Keypair().signPersonalMessage(new TextEncoder().encode(message));
    await expect(t.visitors.login(new Ed25519Keypair().toSuiAddress(), message, signature)).rejects.toThrow(/doesn't match/);
  });

  it("rejects tampered and expired tokens", async () => {
    const t = make();
    const s = await signIn(t.visitors);
    expect(() => t.visitors.authenticate(`${s.token}x`)).toThrow(/connect your wallet/);
    expect(() => t.visitors.authenticate(undefined)).toThrow(/connect your wallet/);
    t.tick(8 * 24 * 3_600_000);
    expect(() => t.visitors.authenticate(s.token)).toThrow(/connect your wallet/);
  });
});

describe("visitor rules", () => {
  it("parses plain English and scopes the rule to the watched demo agent", async () => {
    const t = make();
    const { visitor: v } = await signIn(t.visitors);
    await t.visitors.setAgent(v, "my-bot", "researcher");
    const { rule } = await t.visitors.addRule(v, "pause it if it pays the same address 10 times in 5 min");
    expect(rule).toMatchObject({ id: "v1", action: "pause", scope: { agent: "researcher" }, condition: { kind: "velocity", count: 10, window_min: 5 } });
    await expect(t.visitors.setAgent(v, "my-bot", "not-an-agent")).rejects.toThrow(/demo agents/);
    await expect(t.visitors.addRule(v, "hello there")).rejects.toThrow(/couldn't turn that into a rule/);
  });

  it("moves rules along when the visitor switches agents", async () => {
    const t = make();
    const { visitor: v } = await signIn(t.visitors);
    await t.visitors.setAgent(v, "bot", "researcher");
    await t.visitors.addRule(v, "ask me before any new counterparty");
    await t.visitors.setAgent(v, "bot", "pricebot");
    expect(v.rules[0]!.scope.agent).toBe("pricebot");
  });
});

describe("shadow mode", () => {
  it("alerts a linked visitor, learns from 'Always allow', and never reports a vault action", async () => {
    const t = make();
    const { visitor: v } = await signIn(t.visitors);
    await t.visitors.setAgent(v, "my-bot", "researcher");
    expect(await link(t.visitors, v)).toContain("Linked");

    await t.visitors.observe([ctx()]);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.chatId).toBe("777");
    expect(t.sent[0]!.text).toContain("shadow mode");
    expect(t.sent[0]!.text).toContain(`https://suiscan.xyz/testnet/tx/${DIGEST}`);

    const always = t.sent[0]!.buttons!.flat().find((b) => b.text === "Always allow")!.data;
    expect(await t.visitors.handleChat("777", { kind: "button", data: always })).toContain("Learned");
    expect(v.rules.at(-1)).toMatchObject({ action: "allow", scope: { agent: "researcher", counterparty: addr(9) } });

    // The same payment now replays as allowed, silenced by the visitor's own rule.
    const [item] = t.visitors.replay(v);
    expect(item).toMatchObject({ action: "allow", silencedBy: [v.rules.at(-1)!.id] });
  });

  it("ignores payments of agents the visitor doesn't watch, and unlinked visitors", async () => {
    const t = make();
    const a = await signIn(t.visitors);
    await t.visitors.setAgent(a.visitor, "a", "pricebot");
    await link(t.visitors, a.visitor, "1");
    const b = await signIn(t.visitors);
    await t.visitors.setAgent(b.visitor, "b", "researcher");
    await t.visitors.observe([ctx()]);
    expect(t.sent).toHaveLength(0);
  });

  it("does not repeat the same alert within the hour", async () => {
    const t = make();
    const { visitor: v } = await signIn(t.visitors);
    await t.visitors.setAgent(v, "my-bot", "researcher");
    await link(t.visitors, v);
    await t.visitors.observe([ctx()]);
    t.tick(60_000);
    await t.visitors.observe([ctx()]);
    expect(t.sent).toHaveLength(1);
    t.tick(61 * 60_000);
    await t.visitors.observe([ctx()]);
    expect(t.sent).toHaveLength(2);
  });

  it("tells strangers how to start, and stops messaging after /stop", async () => {
    const t = make();
    expect(await t.visitors.handleChat("42", { kind: "text", text: "hi" })).toContain("https://example.test/try");
    expect(await t.visitors.handleChat("42", { kind: "text", text: "/start bogus" })).toContain("expired");
    const { visitor: v } = await signIn(t.visitors);
    await t.visitors.setAgent(v, "my-bot", "researcher");
    await link(t.visitors, v, "42");
    expect(await t.visitors.handleChat("42", { kind: "text", text: "ask me before any new counterparty over $0.01" })).toContain("Saved");
    expect(await t.visitors.handleChat("42", { kind: "text", text: "/stop" })).toContain("Unlinked");
    await t.visitors.observe([ctx()]);
    expect(t.sent).toHaveLength(0);
  });
});

describe("visitor persistence", () => {
  it("survives a restart from the local file, replay included", async () => {
    const dir = await mkdtemp(join(tmpdir(), "warden-visitors-"));
    const stateFile = join(dir, "visitors.json");
    const t = make({ stateFile });
    const s = await signIn(t.visitors);
    await t.visitors.setAgent(s.visitor, "my-bot", "researcher");
    await t.visitors.addRule(s.visitor, "ask me before any new counterparty over $0.01");
    await t.visitors.observe([ctx()]);

    const again = make({ stateFile });
    await again.visitors.init();
    const v = again.visitors.authenticate(s.token);
    expect(v.rules.map((r) => r.id)).toEqual(["v1"]);
    expect(again.visitors.replay(v)[0]).toMatchObject({ digest: DIGEST, action: "escalate" });
  });

  it("rebuilds visitors from Walrus Memory on a fresh machine", async () => {
    const backend = mockBackend("visitors-test");
    const t = make({ backend });
    const s = await signIn(t.visitors);
    await t.visitors.setAgent(s.visitor, "walrus-bot", "pricebot");

    const fresh = make({ backend });
    await fresh.visitors.init();
    expect(fresh.visitors.get(s.address)).toMatchObject({ agentName: "walrus-bot", watches: "pricebot" });
  });
});

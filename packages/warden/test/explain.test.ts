import { afterEach, describe, expect, it, vi } from "vitest";
import { GroqAlertExplainer, type AlertExplainer, type AlertFacts } from "../src/policy/explain.js";
import { addr, AGENT_IDS, makeWarden } from "./helpers.js";

/** Records what it was asked and answers with a fixed sentence (or fails). */
class StubExplainer implements AlertExplainer {
  asked: AlertFacts[] = [];
  constructor(private readonly reply: string | Error, private readonly onAsk?: () => void) {}
  async explain(facts: AlertFacts): Promise<string | null> {
    this.asked.push(facts);
    this.onAsk?.();
    if (this.reply instanceof Error) throw this.reply;
    return this.reply;
  }
}

describe("alert explanations", () => {
  it("adds the explanation under an escalation and keeps it on the incident", async () => {
    const explainer = new StubExplainer("Researcher paid a vendor it has never used before; approving lets it keep using this vendor.");
    const t = await makeWarden(undefined, { explainer });
    t.chain.spend("researcher", addr(0xa1), 0.002, t.tick(60_000));
    await t.cycle();

    const msg = t.owner.sent.at(-1)!.text;
    expect(msg).toMatch(/^❓/);
    expect(msg).toContain("💬 Researcher paid a vendor it has never used before");
    expect(msg.indexOf("💬")).toBeLessThan(msg.indexOf("What should I do?"));
    expect(explainer.asked[0]).toMatchObject({ action: "escalate", agent: "researcher", paymentUsd: 0.002, newCounterparty: true });
    expect(explainer.asked[0]!.triggers.length).toBeGreaterThan(0);
    expect(t.memory.list("incident")[0]!.explanation).toContain("never used before");
  });

  it("pauses on-chain before asking for the explanation", async () => {
    const paused: boolean[] = [];
    // The probe needs the vault, which only exists once the warden is built.
    const ref: { vault?: { paused: Set<string> } } = {};
    const explainer = new StubExplainer("Rogue kept paying the same API.", () => paused.push(ref.vault!.paused.has(AGENT_IDS.rogue!)));
    const t = await makeWarden(undefined, { explainer });
    ref.vault = t.vault;
    const api = addr(0xb1);
    // Known counterparty, so only the loop is anomalous.
    t.chain.spend("rogue", api, 0.002, t.tick(1_000));
    await t.cycle();
    explainer.asked = [];
    paused.length = 0;

    for (let i = 0; i < 35; i++) t.chain.spend("rogue", api, 0.002, t.tick(2_000), 0.002 * (i + 2));
    await t.cycle();

    const i = explainer.asked.findIndex((f) => f.action === "pause");
    expect(explainer.asked[i]).toMatchObject({ agent: "rogue", onChain: "done" });
    expect(paused[i]).toBe(true); // the vault was already paused when the model was asked
    expect(t.owner.sent.find((m) => m.text.startsWith("⛔"))!.text).toContain("💬 Rogue kept paying the same API.");
  });

  it("still sends the alert, without an explanation, when the model fails", async () => {
    const t = await makeWarden(undefined, { explainer: new StubExplainer(new Error("groq 503")) });
    t.chain.spend("researcher", addr(0xa2), 0.002, t.tick(60_000));
    await t.cycle();
    const msg = t.owner.sent.at(-1)!.text;
    expect(msg).toMatch(/^❓/);
    expect(msg).not.toContain("💬");
    expect(t.memory.list("incident")[0]!.explanation).toBeUndefined();
  });
});

describe("GroqAlertExplainer", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("asks for a short plain-text answer and strips stray markdown", async () => {
    let body: Record<string, unknown> = {};
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: "**Rogue** paid the  same API\n30 times." } }] }));
    });
    const facts: AlertFacts = { action: "pause", agent: "rogue", paymentUsd: 0.002, counterparty: "0x0d4c…d32a", newCounterparty: false, agentSpentTodayUsd: 0.065, agentNormalDailyUsd: 0, daysObserved: 0, triggers: [{ rule: "Freeze an agent that pays the same counterparty 30 times in 10 minutes", detail: "rogue paid 0x0d4c…d32a 30× in 10 min" }], onChain: "done" };

    expect(await new GroqAlertExplainer("k", "m").explain(facts)).toBe("Rogue paid the same API 30 times.");
    expect(body).toMatchObject({ model: "m", max_tokens: 300 });
    expect(JSON.stringify(body)).toContain("30 times in 10 minutes");
  });
});

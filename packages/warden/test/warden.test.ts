import { describe, expect, it } from "vitest";
import { WardenMemory } from "../src/memory/store.js";
import { mockBackend } from "../src/memory/walrus.js";
import { addr, AGENT_IDS, makeWarden } from "./helpers.js";

const button = (owner: { sent: { buttons?: { data: string }[][] }[] }, label: string) => {
  const last = owner.sent.at(-1)!;
  return last.buttons!.flat().find((b) => b.data.endsWith(`:${label}`))!.data;
};

describe("Warden learning loop", () => {
  it("asks about new counterparties in week 1, then generalises from the owner's approvals", async () => {
    const t = await makeWarden();
    const vendors = [addr(0xa1), addr(0xa2), addr(0xa3), addr(0xa4)];

    for (let i = 0; i < 3; i++) {
      t.chain.spend("researcher", vendors[i]!, 0.002, t.tick(60_000));
      const [item] = await t.cycle();
      expect(item!.decision.action).toBe("escalate");
      const reply = await t.warden.handleOwner({ kind: "button", data: button(t.owner, "always") });
      expect(reply).toContain("Learned");
      if (i === 2) expect(reply).toContain("may pay new counterparties up to $0.003");
    }

    // 4th new vendor, small amount: handled silently by the generalised rule.
    const asked = t.owner.sent.length;
    t.chain.spend("researcher", vendors[3]!, 0.002, t.tick(60_000));
    const [item] = await t.cycle();
    expect(item!.decision.action).toBe("allow");
    expect(item!.decision.suppressed[0]?.trigger.rule.id).toBe("default_new_counterparty");
    expect(t.owner.sent.length).toBe(asked);

    // A big payment to a new vendor still escalates: the learned rule is bounded.
    t.chain.spend("researcher", addr(0xa5), 0.04, t.tick(60_000));
    expect((await t.cycle())[0]!.decision.action).toBe("escalate");

    const metric = t.memory.get("metric", "2026-10-22")!;
    expect(metric.escalations).toBe(4);
    expect(metric.auto_handled).toBe(1);
    expect(t.memory.list("feedback")).toHaveLength(3);
  });

  it("pauses a looping agent once, without asking", async () => {
    const t = await makeWarden();
    const api = addr(0xb1);
    // Known counterparty: approve it first so only the loop is anomalous.
    t.chain.spend("rogue", api, 0.002, t.tick(1_000));
    await t.cycle();
    await t.warden.handleOwner({ kind: "button", data: button(t.owner, "always") });

    for (let i = 0; i < 35; i++) t.chain.spend("rogue", api, 0.002, t.tick(2_000), 0.002 * (i + 2));
    const items = await t.cycle();
    expect(items.some((x) => x.decision.action === "pause")).toBe(true);
    expect(t.vault.calls.filter((c) => c.startsWith("pause:"))).toEqual([`pause:${AGENT_IDS.rogue}`]);
    const inc = t.memory.list("incident").find((i) => i.action === "pause")!;
    expect(inc.what).toMatch(/paid 0x0000…00b1 30× in 10 min/);

    // Owner keeps it paused; the rogue keeps hammering and gets rejected on-chain.
    await t.warden.handleOwner({ kind: "button", data: button(t.owner, "keep") });
    for (let i = 0; i < 5; i++) t.chain.reject("rogue", api, 0.002, t.tick(1_000));
    const rejected = await t.cycle();
    expect(rejected.at(-1)!.decision.action).toBe("escalate");
    expect(t.owner.sent.at(-1)!.text).toContain("blocked by the vault");
  });

  it("turns a plain-English rule into an on-chain cap immediately", async () => {
    const t = await makeWarden();
    t.chain.spend("pricebot", addr(0xc1), 0.001, t.tick(1_000));
    await t.cycle();
    const reply = await t.warden.handleOwner({ kind: "text", text: "Block anything over $20/day" });
    expect(reply).toContain("rule_001");
    expect(t.vault.calls).toContain(`tighten:${AGENT_IDS.pricebot}:-:20`);
    const rule = t.memory.get("rule", "rule_001")!;
    expect(rule.condition).toEqual({ kind: "daily_over", usd: 20 });
    expect(rule.source).toBe("telegram");
  });

  it("'allow once' stops repeat questions for the rest of the day, then asks again", async () => {
    const t = await makeWarden();
    const api = addr(0xf1);
    t.chain.spend("pricebot", api, 0.001, t.tick(60_000));
    await t.cycle();
    await t.warden.handleOwner({ kind: "button", data: button(t.owner, "once") });
    const asked = t.owner.sent.length;

    t.chain.spend("pricebot", api, 0.001, t.tick(2 * 3_600_000)); // same day, past the 60-min dedupe
    expect((await t.cycle())[0]!.decision.action).toBe("escalate");
    expect(t.owner.sent.length).toBe(asked);

    t.chain.spend("pricebot", api, 0.001, t.tick(24 * 3_600_000)); // next day (also triggers the daily digest)
    await t.cycle();
    expect(t.owner.sent.slice(asked).filter((m) => m.text.startsWith("❓"))).toHaveLength(1);
  });

  it("does not reprocess events replayed after a restart", async () => {
    const t = await makeWarden();
    t.chain.spend("pricebot", addr(0xd1), 0.001, t.tick(1_000));
    const ev = [...t.chain.queue];
    await t.cycle();
    t.chain.queue.push(...ev);
    expect(await t.cycle()).toHaveLength(0);
  });

  it("writes every learned rule, incident and feedback to Walrus Memory", async () => {
    const t = await makeWarden();
    t.chain.spend("researcher", addr(0xe1), 0.002, t.tick(1_000));
    await t.cycle();
    await t.warden.handleOwner({ kind: "button", data: button(t.owner, "always") });
    await t.memory.flush();
    const hits = await t.memory.search("Warden rule always allow researcher", 20);
    expect(hits.some((h) => h.includes("rule_001"))).toBe(true);
    expect(t.memory.stats().pending).toBe(0);
    expect(t.memory.stats().walrusWrites).toBeGreaterThanOrEqual(10);
  });

  it("keeps today's counters across a restart on a fresh machine", async () => {
    const backend = mockBackend("restart");
    const t = await makeWarden(undefined, { backend });
    t.chain.spend("pricebot", addr(0xf1), 0.001, t.tick(1_000));
    t.chain.spend("pricebot", addr(0xf1), 0.001, t.tick(1_000));
    await t.cycle();
    t.warden.persistProgress(); // what shutdown and the 15-min checkpoint do
    await t.memory.flush();

    const fresh = new WardenMemory(backend, null);
    await fresh.rebuildFromWalrus(["metric", "cursor"]);
    const today = new Date(t.now()).toISOString().slice(0, 10);
    expect(fresh.get("metric", today)).toMatchObject({ events: 2 });
    expect(fresh.get("cursor", "observer")?.event_cursor).not.toBeNull();
  });
});

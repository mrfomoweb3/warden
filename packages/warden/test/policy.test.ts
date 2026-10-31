import { describe, expect, it } from "vitest";
import type { RuleRecord } from "../src/memory/schema.js";
import { findLookalike, type PaymentContext } from "../src/policy/context.js";
import { PatternIntentParser } from "../src/policy/parser.js";
import { decide, defaultRules } from "../src/policy/rules.js";
import { addr } from "./helpers.js";

function ctx(over: Partial<PaymentContext> = {}): PaymentContext {
  return {
    event: { kind: "spent", agentId: addr(1), label: "researcher", recipient: addr(9), amount: 1n, memo: "", spentToday: 1n, ts: 0, digest: "d", seq: "0" },
    agent: "researcher",
    counterparty: addr(9),
    amountUsd: 0.01,
    dailyUsd: 0.5,
    isNewCounterparty: false,
    baselineDailyUsd: 0.4,
    daysObserved: 3,
    velocity: () => 1,
    rejectedCount: () => 0,
    ...over,
  };
}

const rule = (r: Partial<RuleRecord> & Pick<RuleRecord, "condition" | "action">): RuleRecord => ({
  type: "rule",
  id: r.id ?? "r",
  text: "",
  scope: {},
  source: "telegram",
  created: "",
  enabled: true,
  ...r,
});

describe("decide", () => {
  const defaults = defaultRules("t");

  it("allows a normal payment silently", () => {
    expect(decide(defaults, ctx()).action).toBe("allow");
  });

  it("escalates a new counterparty under the week-1 defaults", () => {
    const d = decide(defaults, ctx({ isNewCounterparty: true }));
    expect(d.action).toBe("escalate");
    expect(d.triggers.map((t) => t.rule.id)).toEqual(["default_new_counterparty"]);
  });

  it("pause outranks escalate", () => {
    expect(decide(defaults, ctx({ isNewCounterparty: true, velocity: () => 40 })).action).toBe("pause");
  });

  it("a learned allow suppresses only its own condition, within its amount bound", () => {
    const allow = rule({ id: "rule_001", scope: { agent: "researcher" }, condition: { kind: "new_counterparty" }, action: "allow", amount_max_usd: 0.05 });
    expect(decide([...defaults, allow], ctx({ isNewCounterparty: true })).action).toBe("allow");
    expect(decide([...defaults, allow], ctx({ isNewCounterparty: true, amountUsd: 1 })).action).toBe("escalate");
    expect(decide([...defaults, allow], ctx({ isNewCounterparty: true, velocity: () => 40 })).action).toBe("pause");
  });

  it("an allow scoped to another agent does not apply", () => {
    const allow = rule({ scope: { agent: "pricebot" }, condition: { kind: "new_counterparty" }, action: "allow" });
    expect(decide([...defaults, allow], ctx({ isNewCounterparty: true })).action).toBe("escalate");
  });

  it("a broad allow cannot override a narrower escalate", () => {
    const escalate = rule({ id: "e", scope: { agent: "researcher", counterparty: addr(9) }, condition: { kind: "any_payment" }, action: "escalate" });
    const allow = rule({ id: "a", scope: { agent: "researcher" }, condition: { kind: "any_payment" }, action: "allow" });
    expect(decide([escalate, allow], ctx()).action).toBe("escalate");
  });

  it("combines tighten rules to the strictest caps", () => {
    const a = rule({ condition: { kind: "daily_over", usd: 0.1 }, action: "tighten", tighten: { daily_usd: 20 } });
    const b = rule({ condition: { kind: "daily_over", usd: 0.1 }, action: "tighten", tighten: { daily_usd: 5, per_tx_usd: 1 } });
    expect(decide([a, b], ctx()).tighten).toEqual({ daily_usd: 5, per_tx_usd: 1 });
  });

  it("ignores baseline spikes until a baseline exists", () => {
    expect(decide(defaults, ctx({ dailyUsd: 10, daysObserved: 0 })).action).toBe("allow");
    expect(decide(defaults, ctx({ dailyUsd: 10 })).action).toBe("escalate");
  });
});

describe("findLookalike", () => {
  it("flags an address sharing prefix and suffix with a known one", () => {
    const known = "0xabcd" + "1".repeat(56) + "ef01";
    const poison = "0xabcd" + "9".repeat(56) + "ef01";
    expect(findLookalike(poison, [known])).toBe(known);
    expect(findLookalike(known, [known])).toBeUndefined();
    expect(findLookalike("0x1234" + "9".repeat(56) + "ef01", [known])).toBeUndefined();
  });
});

describe("PatternIntentParser", () => {
  const p = new PatternIntentParser();
  const agents = { agents: ["researcher", "pricebot", "rogue"] };

  it.each([
    ["block anything over $20/day", { kind: "daily_over", usd: 20 }, "tighten"],
    ["ask me before any new counterparty over $5", { kind: "new_counterparty" }, "escalate"],
    ["freeze an agent that pays the same API 50× in an hour", { kind: "velocity", count: 50, window_min: 60 }, "pause"],
    ["researcher can pay new APIs under $0.10", { kind: "new_counterparty" }, "allow"],
  ])("%s", async (text, condition, action) => {
    const r = await p.parse(text, agents);
    expect(r.intent).toBe("rule");
    if (r.intent !== "rule") return;
    expect(r.rule.condition).toEqual(condition);
    expect(r.rule.action).toBe(action);
  });

  it("scopes to a named agent", async () => {
    const r = await p.parse("block anything over $2 per day for pricebot", agents);
    expect(r.intent === "rule" && r.rule.scope).toEqual({ agent: "pricebot" });
  });

  it("reads replies to an open incident", async () => {
    const incident = { id: "i", agent: "rogue", what: "x", condition_kinds: ["velocity"] };
    expect(await p.parse("fine, always allow that", { ...agents, incident })).toMatchObject({ intent: "resolve", decision: "always_allow" });
    expect(await p.parse("ok", { ...agents, incident })).toMatchObject({ intent: "resolve", decision: "allow_once" });
    expect(await p.parse("stop it", { ...agents, incident })).toMatchObject({ intent: "resolve", decision: "pause" });
  });
});

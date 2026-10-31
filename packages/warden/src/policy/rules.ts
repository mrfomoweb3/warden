import { normalizeSuiAddress } from "@mysten/sui/utils";
import type { Action, ConditionKind, RuleRecord } from "../memory/schema.js";
import type { PaymentContext } from "./context.js";

export interface Trigger {
  rule: RuleRecord;
  detail: string;
}

export interface Decision {
  action: Action;
  triggers: Trigger[];
  /** Triggers overridden by a learned allow rule; kept for the audit trail. */
  suppressed: { trigger: Trigger; by: string }[];
  tighten?: { per_tx_usd?: number; daily_usd?: number };
}

const SEVERITY: Record<Action, number> = { allow: 0, escalate: 1, tighten: 2, pause: 3 };

const usd = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** Returns why the rule fires on this payment, or null. Pure. */
export function fires(rule: RuleRecord, ctx: PaymentContext): string | null {
  if (!rule.enabled) return null;
  if (rule.scope.agent && rule.scope.agent !== ctx.agent) return null;
  if (rule.scope.counterparty && normalizeSuiAddress(rule.scope.counterparty) !== ctx.counterparty) return null;
  if (rule.amount_min_usd !== undefined && ctx.amountUsd < rule.amount_min_usd) return null;
  if (rule.amount_max_usd !== undefined && ctx.amountUsd > rule.amount_max_usd) return null;

  const c = rule.condition;
  const spent = ctx.event.kind === "spent";
  switch (c.kind) {
    case "any_payment":
      return spent ? `${ctx.agent} paid ${usd(ctx.amountUsd)} to ${short(ctx.counterparty)}` : null;
    case "amount_over":
      return spent && ctx.amountUsd > c.usd ? `${ctx.agent} paid ${usd(ctx.amountUsd)} in one go (limit ${usd(c.usd)})` : null;
    case "daily_over":
      return spent && ctx.dailyUsd > c.usd ? `${ctx.agent} has spent ${usd(ctx.dailyUsd)} today (limit ${usd(c.usd)})` : null;
    case "new_counterparty":
      return spent && ctx.isNewCounterparty ? `${ctx.agent} paid a new counterparty ${short(ctx.counterparty)} (${usd(ctx.amountUsd)})` : null;
    case "velocity": {
      const n = ctx.velocity(c.window_min);
      return spent && n >= c.count ? `${ctx.agent} paid ${short(ctx.counterparty)} ${n}× in ${c.window_min} min` : null;
    }
    case "lookalike_address":
      return spent && ctx.lookalikeOf
        ? `${ctx.agent} paid ${short(ctx.counterparty)}, which imitates known counterparty ${short(ctx.lookalikeOf)}`
        : null;
    case "baseline_spike":
      return spent && ctx.daysObserved >= 1 && ctx.baselineDailyUsd > 0 && ctx.dailyUsd > c.factor * ctx.baselineDailyUsd
        ? `${ctx.agent} is at ${usd(ctx.dailyUsd)} today, ${(ctx.dailyUsd / ctx.baselineDailyUsd).toFixed(1)}× its normal ${usd(ctx.baselineDailyUsd)}`
        : null;
    case "rejected_burst": {
      if (ctx.event.kind !== "rejected") return null;
      const n = ctx.rejectedCount(c.window_min);
      return n >= c.count ? `${ctx.agent} had ${n} spends blocked by the vault in ${c.window_min} min (${ctx.event.reason})` : null;
    }
    case "risky_counterparty":
      return spent && ctx.risk && ctx.risk.score >= c.min_score
        ? `${short(ctx.counterparty)} scored ${ctx.risk.score.toFixed(2)} on the risk check (${ctx.risk.flags.join(", ") || "no flags"})`
        : null;
  }
}

function specificity(r: RuleRecord): number {
  return (r.scope.counterparty ? 2 : 0) + (r.scope.agent ? 1 : 0);
}

/**
 * Evaluates all rules. A fired `allow` rule suppresses fired non-allow rules on the
 * same condition kind whose scope is no more specific than its own. The most severe
 * remaining action wins; no triggers means allow (handled silently).
 */
export function decide(rules: RuleRecord[], ctx: PaymentContext): Decision {
  const fired: Trigger[] = [];
  for (const rule of rules) {
    const detail = fires(rule, ctx);
    if (detail) fired.push({ rule, detail });
  }
  const allows = fired.filter((t) => t.rule.action === "allow");
  const triggers: Trigger[] = [];
  const suppressed: Decision["suppressed"] = [];
  for (const t of fired) {
    if (t.rule.action === "allow") continue;
    const by = allows.find((a) => sameKind(a.rule.condition.kind, t.rule.condition.kind) && specificity(a.rule) >= specificity(t.rule));
    if (by) suppressed.push({ trigger: t, by: by.rule.id });
    else triggers.push(t);
  }
  let action: Action = "allow";
  for (const t of triggers) if (SEVERITY[t.rule.action] > SEVERITY[action]) action = t.rule.action;

  let tighten: Decision["tighten"];
  if (action === "tighten") {
    for (const t of triggers.filter((x) => x.rule.action === "tighten")) {
      tighten = {
        per_tx_usd: min(tighten?.per_tx_usd, t.rule.tighten?.per_tx_usd),
        daily_usd: min(tighten?.daily_usd, t.rule.tighten?.daily_usd),
      };
    }
  }
  return { action, triggers, suppressed, tighten };
}

function sameKind(a: ConditionKind, b: ConditionKind): boolean {
  return a === b || a === "any_payment";
}

function min(a?: number, b?: number): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

/** Week-1 defaults: cautious, so the owner is asked a lot until rules are learned. */
export function defaultRules(now = new Date().toISOString()): RuleRecord[] {
  const base = { type: "rule" as const, scope: {}, source: "default" as const, created: now, enabled: true };
  return [
    { ...base, id: "default_new_counterparty", text: "Ask me before an agent pays a counterparty it has never paid before", condition: { kind: "new_counterparty" }, action: "escalate" },
    { ...base, id: "default_velocity", text: "Freeze an agent that pays the same counterparty 30 times in 10 minutes", condition: { kind: "velocity", count: 30, window_min: 10 }, action: "pause" },
    { ...base, id: "default_lookalike", text: "Freeze an agent that pays an address imitating a known counterparty", condition: { kind: "lookalike_address" }, action: "pause" },
    { ...base, id: "default_spike", text: "Ask me when an agent spends more than 3x its normal daily amount", condition: { kind: "baseline_spike", factor: 3 }, action: "escalate" },
    { ...base, id: "default_rejected", text: "Tell me when the vault blocks an agent 5 times in 10 minutes", condition: { kind: "rejected_burst", count: 5, window_min: 10 }, action: "escalate" },
    { ...base, id: "default_risky", text: "Ask me before trusting a counterparty that fails the paid risk check", condition: { kind: "risky_counterparty", min_score: 0.7 }, action: "escalate" },
  ];
}

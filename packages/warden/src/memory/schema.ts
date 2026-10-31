import { z } from "zod";

/** Condition a rule tests. Amount bounds narrow any condition to a USD range. */
export const Condition = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("any_payment") }),
  z.object({ kind: z.literal("amount_over"), usd: z.number().nonnegative() }),
  z.object({ kind: z.literal("daily_over"), usd: z.number().nonnegative() }),
  z.object({ kind: z.literal("new_counterparty") }),
  z.object({ kind: z.literal("velocity"), count: z.number().int().positive(), window_min: z.number().positive() }),
  z.object({ kind: z.literal("lookalike_address") }),
  z.object({ kind: z.literal("baseline_spike"), factor: z.number().positive() }),
  z.object({ kind: z.literal("rejected_burst"), count: z.number().int().positive(), window_min: z.number().positive() }),
  z.object({ kind: z.literal("risky_counterparty"), min_score: z.number().min(0).max(1) }),
]);
export type Condition = z.infer<typeof Condition>;
export type ConditionKind = Condition["kind"];

export const Action = z.enum(["allow", "escalate", "tighten", "pause"]);
export type Action = z.infer<typeof Action>;

export const RuleRecord = z.object({
  type: z.literal("rule"),
  id: z.string(),
  text: z.string(),
  scope: z.object({ agent: z.string().optional(), counterparty: z.string().optional() }).default({}),
  condition: Condition,
  amount_min_usd: z.number().nonnegative().optional(),
  amount_max_usd: z.number().nonnegative().optional(),
  action: Action,
  /** For `tighten`: the caps to set, in USD. */
  tighten: z.object({ per_tx_usd: z.number().nonnegative().optional(), daily_usd: z.number().nonnegative().optional() }).optional(),
  source: z.enum(["default", "telegram", "feedback", "claude-code"]),
  created: z.string(),
  enabled: z.boolean().default(true),
  /** Incident/decision this rule was learned from, for traceability. */
  learned_from: z.string().optional(),
});
export type RuleRecord = z.infer<typeof RuleRecord>;

export const AgentProfile = z.object({
  type: z.literal("agent_profile"),
  agent: z.string(),
  agent_id: z.string(),
  normal_daily_spend_usd: z.number().default(0),
  days_observed: z.number().int().default(0),
  typical_counterparties: z.array(z.string()).default([]),
  calls_per_hour_p95: z.number().default(0),
  last_day: z.string().optional(),
  updated: z.string(),
});
export type AgentProfile = z.infer<typeof AgentProfile>;

export const Counterparty = z.object({
  type: z.literal("counterparty"),
  address: z.string(),
  label: z.string().optional(),
  first_seen: z.string(),
  seen_by: z.array(z.string()).default([]),
  payments: z.number().int().default(0),
  total_usd: z.number().default(0),
  trust: z.number().min(0).max(1).default(0.5),
  risk_check: z.object({ score: z.number(), flags: z.array(z.string()), checked: z.string(), paid_tx: z.string().optional() }).optional(),
});
export type Counterparty = z.infer<typeof Counterparty>;

export const Incident = z.object({
  type: z.literal("incident"),
  id: z.string(),
  agent: z.string(),
  counterparty: z.string().optional(),
  what: z.string(),
  rule_ids: z.array(z.string()),
  condition_kinds: z.array(z.string()),
  action: Action,
  tx: z.string().optional(),
  status: z.enum(["open", "resolved"]),
  resolved_by: z.enum(["owner", "warden"]).optional(),
  outcome: z.string().optional(),
  /** Plain-language explanation sent with the alert (written by the explainer model). */
  explanation: z.string().optional(),
  created: z.string(),
});
export type Incident = z.infer<typeof Incident>;

export const Feedback = z.object({
  type: z.literal("feedback"),
  id: z.string(),
  incident: z.string().optional(),
  decision: Action.optional(),
  owner_reply: z.string(),
  rule_change: z.string().optional(),
  created: z.string(),
});
export type Feedback = z.infer<typeof Feedback>;

/** Hourly roll-up of observed payments: the long-term record once the gateway's ~3-day window rolls past. */
export const Activity = z.object({
  type: z.literal("activity"),
  key: z.string(),
  agent: z.string(),
  hour: z.string(),
  payments: z.number().int(),
  usd: z.number(),
  rejected: z.number().int(),
  counterparties: z.record(z.number()),
  sample_txs: z.array(z.string()),
});
export type Activity = z.infer<typeof Activity>;

export const Metric = z.object({
  type: z.literal("metric"),
  day: z.string(),
  events: z.number().int(),
  auto_handled: z.number().int(),
  escalations: z.number().int(),
  pauses: z.number().int(),
  tightens: z.number().int(),
  rules_learned: z.number().int(),
});
export type Metric = z.infer<typeof Metric>;

export const Cursor = z.object({
  type: z.literal("cursor"),
  key: z.literal("observer"),
  /** Tatum gRPC ListTransactions resume point: checkpoint + opaque stream cursor (base64). */
  event_cursor: z.object({ checkpoint: z.string(), after: z.string().nullable() }).nullable(),
  updated: z.string(),
});
export type Cursor = z.infer<typeof Cursor>;

export const MemoryRecord = z.discriminatedUnion("type", [RuleRecord, AgentProfile, Counterparty, Incident, Feedback, Activity, Metric, Cursor]);
export type MemoryRecord = z.infer<typeof MemoryRecord>;
export type RecordType = MemoryRecord["type"];
export type RecordOf<T extends RecordType> = Extract<MemoryRecord, { type: T }>;

export function keyOf(r: MemoryRecord): string {
  switch (r.type) {
    case "rule":
    case "incident":
    case "feedback":
      return r.id;
    case "agent_profile":
      return r.agent;
    case "counterparty":
      return r.address;
    case "activity":
    case "cursor":
      return r.key;
    case "metric":
      return r.day;
  }
}

/** One plain-English line per record, so memories read well in Claude Code / the dashboard. */
export function describe(r: MemoryRecord): string {
  switch (r.type) {
    case "rule":
      return `Warden rule ${r.id} (${r.enabled ? "active" : "disabled"}, from ${r.source}): "${r.text}" → ${r.action}${scopeText(r.scope)}.`;
    case "agent_profile":
      return `Agent profile for ${r.agent}: normally spends about $${r.normal_daily_spend_usd.toFixed(2)}/day over ${r.days_observed} days, pays ${r.typical_counterparties.length} usual counterparties, ~${r.calls_per_hour_p95} calls/hour at peak.`;
    case "counterparty":
      return `Counterparty ${r.address}${r.label ? ` (${r.label})` : ""}: first seen ${r.first_seen}, ${r.payments} payments totalling $${r.total_usd.toFixed(2)} from ${r.seen_by.join(", ") || "nobody"}, trust ${r.trust.toFixed(2)}${r.risk_check ? `, risk score ${r.risk_check.score}` : ""}.`;
    case "incident":
      return `Incident ${r.id} on agent ${r.agent}: ${r.what}. Warden action: ${r.action}. Status: ${r.status}${r.outcome ? ` (${r.outcome})` : ""}.${r.explanation ? ` Why: ${r.explanation}` : ""}`;
    case "feedback":
      return `Owner feedback ${r.id}${r.incident ? ` on incident ${r.incident}` : ""}: "${r.owner_reply}"${r.rule_change ? ` → changed rule ${r.rule_change}` : ""}.`;
    case "activity":
      return `Activity ${r.agent} ${r.hour}: ${r.payments} payments, $${r.usd.toFixed(2)}, ${r.rejected} rejected, ${Object.keys(r.counterparties).length} counterparties.`;
    case "metric":
      return `Warden metrics ${r.day}: ${r.events} payments seen, ${r.auto_handled} handled silently, ${r.escalations} questions to owner, ${r.pauses} pauses, ${r.rules_learned} rules learned.`;
    case "cursor":
      return `Warden observer cursor at ${r.event_cursor ? `checkpoint ${r.event_cursor.checkpoint}` : "start"}.`;
  }
}

function scopeText(s: RuleRecord["scope"]): string {
  const parts = [s.agent && `agent ${s.agent}`, s.counterparty && `counterparty ${s.counterparty}`].filter(Boolean);
  return parts.length ? ` (only for ${parts.join(", ")})` : "";
}

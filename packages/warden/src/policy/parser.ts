import { z } from "zod/v4";
import { RuleRecord } from "../memory/schema.js";
import { groqChat, type GroqConfig } from "./groq.js";

/** What the owner meant by a message. */
export type OwnerIntent =
  | { intent: "rule"; rule: Omit<RuleRecord, "id" | "created" | "source" | "type" | "enabled">; summary: string }
  | { intent: "resolve"; decision: "allow_once" | "always_allow" | "pause" | "unpause"; summary: string }
  | { intent: "other"; summary: string };

export interface ParseContext {
  agents: string[];
  /** The open incident the owner is most likely replying to. */
  incident?: { id: string; agent: string; counterparty?: string; what: string; condition_kinds: string[] };
}

export interface IntentParser {
  parse(text: string, ctx: ParseContext): Promise<OwnerIntent>;
}

// Flat schema: models fill nullable scalars more reliably than nested unions.
const LlmIntent = z.object({
  intent: z.enum(["rule", "resolve", "other"]),
  decision: z.enum(["allow_once", "always_allow", "pause", "unpause"]).nullable(),
  condition_kind: z
    .enum(["any_payment", "amount_over", "daily_over", "new_counterparty", "velocity", "lookalike_address", "baseline_spike", "rejected_burst", "risky_counterparty"])
    .nullable(),
  usd: z.number().nullable(),
  count: z.number().nullable(),
  window_min: z.number().nullable(),
  factor: z.number().nullable(),
  min_score: z.number().nullable(),
  agent: z.string().nullable(),
  counterparty: z.string().nullable(),
  amount_min_usd: z.number().nullable(),
  amount_max_usd: z.number().nullable(),
  action: z.enum(["allow", "escalate", "tighten", "pause"]).nullable(),
  tighten_per_tx_usd: z.number().nullable(),
  tighten_daily_usd: z.number().nullable(),
  summary: z.string(),
});
type LlmIntent = z.infer<typeof LlmIntent>;

const SYSTEM = `You translate a wallet owner's plain-English messages into structured policy for Warden, a watchdog that monitors AI agents' payments on Sui.

Intents:
- "rule": a standing policy. Map it to one condition and one action.
- "resolve": a reply to the open incident (e.g. "fine", "that's ok, always allow it", "stop it", "turn it back on").
  "fine"/"ok this time" → allow_once; "always"/"don't ask again" → always_allow; "stop"/"freeze" → pause; "resume"/"unfreeze" → unpause.
- "other": anything else (questions, chit-chat).

Conditions: any_payment; amount_over{usd} (single payment above usd); daily_over{usd} (agent's spend today above usd);
new_counterparty (agent pays an address it never paid before); velocity{count, window_min} (same counterparty count times within window);
lookalike_address (address imitating a known one); baseline_spike{factor} (today's spend above factor × normal);
rejected_burst{count, window_min} (vault blocked the agent count times); risky_counterparty{min_score 0-1}.

Actions: allow (do not bother me), escalate (ask me), tighten (lower the on-chain caps — set tighten_per_tx_usd / tighten_daily_usd), pause (freeze the agent).
"Block anything over $X/day" means daily_over X with action tighten and tighten_daily_usd X, because the vault then enforces it on-chain.
"Ask me before any new counterparty over $5" means new_counterparty, action escalate, amount_min_usd 5.
"Hour" is 60 minutes. Scope a rule to an agent only if the owner names one of the known agents.
If the reply concerns the open incident and says "always"/"from now on", use intent "resolve" with always_allow.
Leave fields that do not apply as null. summary: one short sentence restating what you understood.`;

const SCHEMA = JSON.stringify(z.toJSONSchema(LlmIntent));

/** Parses owner messages with a Groq-hosted model (OpenAI-compatible chat API, JSON mode). */
export class GroqIntentParser implements IntentParser {
  private readonly cfg: GroqConfig;

  constructor(apiKey: string, model = "openai/gpt-oss-120b", baseUrl?: string) {
    this.cfg = { apiKey, model, baseUrl };
  }

  async parse(text: string, ctx: ParseContext): Promise<OwnerIntent> {
    const context = [
      `Known agents: ${ctx.agents.join(", ") || "none"}.`,
      ctx.incident
        ? `Open incident ${ctx.incident.id} on agent ${ctx.incident.agent}: ${ctx.incident.what}.`
        : "No open incident.",
    ].join("\n");
    const content = await groqChat(
      this.cfg,
      [
        { role: "system", content: `${SYSTEM}\n\nReply with one JSON object matching this JSON Schema, every key present:\n${SCHEMA}` },
        { role: "user", content: `${context}\n\nOwner message:\n${text}` },
      ],
      { json: true },
    );
    let json: unknown;
    try {
      json = JSON.parse(content);
    } catch {
      json = null;
    }
    // Models sometimes omit keys instead of writing null; fill them before validating.
    const filled = json && typeof json === "object" ? Object.fromEntries(Object.keys(LlmIntent.shape).map((k) => [k, (json as Record<string, unknown>)[k] ?? null])) : null;
    const parsed = LlmIntent.safeParse(filled);
    if (!parsed.success) {
      return { intent: "other", summary: "I couldn't turn that into a rule. Try e.g. \"block anything over $20/day\"." };
    }
    return toIntent(parsed.data);
  }
}

function toIntent(o: LlmIntent): OwnerIntent {
  if (o.intent === "resolve" && o.decision) return { intent: "resolve", decision: o.decision, summary: o.summary };
  if (o.intent !== "rule" || !o.condition_kind || !o.action) return { intent: "other", summary: o.summary };
  const condition = (() => {
    switch (o.condition_kind) {
      case "amount_over":
      case "daily_over":
        return { kind: o.condition_kind, usd: o.usd ?? 0 };
      case "velocity":
      case "rejected_burst":
        return { kind: o.condition_kind, count: o.count ?? 10, window_min: o.window_min ?? 60 };
      case "baseline_spike":
        return { kind: o.condition_kind, factor: o.factor ?? 3 };
      case "risky_counterparty":
        return { kind: o.condition_kind, min_score: o.min_score ?? 0.7 };
      default:
        return { kind: o.condition_kind };
    }
  })();
  const candidate = {
    type: "rule",
    id: "tmp",
    created: new Date().toISOString(),
    source: "telegram",
    enabled: true,
    text: o.summary,
    scope: { ...(o.agent ? { agent: o.agent } : {}), ...(o.counterparty ? { counterparty: o.counterparty } : {}) },
    condition,
    action: o.action,
    ...(o.amount_min_usd != null ? { amount_min_usd: o.amount_min_usd } : {}),
    ...(o.amount_max_usd != null ? { amount_max_usd: o.amount_max_usd } : {}),
    ...(o.action === "tighten"
      ? { tighten: { per_tx_usd: o.tighten_per_tx_usd ?? undefined, daily_usd: o.tighten_daily_usd ?? (o.condition_kind === "daily_over" ? (o.usd ?? undefined) : undefined) } }
      : {}),
  };
  const parsed = RuleRecord.safeParse(candidate);
  if (!parsed.success) return { intent: "other", summary: `I understood "${o.summary}" but couldn't make it a valid rule.` };
  const { id: _i, created: _c, source: _s, type: _t, enabled: _e, ...rule } = parsed.data;
  return { intent: "rule", rule, summary: o.summary };
}

const money = String.raw`\$\s*(\d+(?:\.\d+)?)`;

/**
 * Deterministic fallback for the phrasings in the demo script. Used when no
 * GROQ_API_KEY is set, and in tests.
 */
export class PatternIntentParser implements IntentParser {
  async parse(text: string, ctx: ParseContext): Promise<OwnerIntent> {
    const t = text.toLowerCase().trim();
    const agent = ctx.agents.find((a) => new RegExp(`\\b${a.toLowerCase()}\\b`).test(t));
    const scope = agent ? { agent } : {};

    if (ctx.incident) {
      if (/\b(always|from now on|don'?t ask)\b/.test(t)) return { intent: "resolve", decision: "always_allow", summary: "Always allow this from now on." };
      if (/^(unpause|resume|unfreeze|turn .* back on)/.test(t)) return { intent: "resolve", decision: "unpause", summary: "Resume the agent." };
      if (/^(pause|stop|freeze|kill)/.test(t)) return { intent: "resolve", decision: "pause", summary: "Pause the agent." };
      if (/^(fine|ok|okay|yes|approve|allow|that'?s fine)\b/.test(t)) return { intent: "resolve", decision: "allow_once", summary: "Allow this one time." };
    }

    let m: RegExpExecArray | null;
    if ((m = new RegExp(`(?:block|limit|cap).*?over ${money}\\s*(?:/|a |per )\\s*day`).exec(t))) {
      const usd = Number(m[1]);
      return rule({ scope, condition: { kind: "daily_over", usd }, action: "tighten", tighten: { daily_usd: usd } }, `Cap ${agent ?? "every agent"} at $${usd}/day on-chain.`, text);
    }
    if ((m = new RegExp(`ask me before (?:any|a) new counterparty(?: over ${money})?`).exec(t))) {
      const min = m[1] ? Number(m[1]) : undefined;
      return rule({ scope, condition: { kind: "new_counterparty" }, action: "escalate", ...(min !== undefined ? { amount_min_usd: min } : {}) }, `Ask before any new counterparty${min !== undefined ? ` over $${min}` : ""}.`, text);
    }
    if ((m = new RegExp(`(?:can|may) pay (?:any )?new (?:counterpart(?:y|ies)|apis?).*?(?:under|below) ${money}`).exec(t))) {
      const max = Number(m[1]);
      return rule({ scope, condition: { kind: "new_counterparty" }, action: "allow", amount_max_usd: max }, `${agent ?? "Agents"} may pay new counterparties under $${max} without asking.`, text);
    }
    if ((m = /(?:freeze|pause|stop).*?(\d+)\s*(?:×|x|times).*?(?:in|within) (?:an? |(\d+)\s*)?(hour|min)/.exec(t))) {
      const count = Number(m[1]);
      const window = m[3] === "hour" ? 60 * (m[2] ? Number(m[2]) : 1) : Number(m[2] ?? 10);
      return rule({ scope, condition: { kind: "velocity", count, window_min: window }, action: "pause" }, `Pause ${agent ?? "an agent"} that pays the same counterparty ${count}× within ${window} min.`, text);
    }
    if ((m = new RegExp(`(?:ask|tell) me.*?(?:over|above|more than) ${money}(?! ?/ ?day)`).exec(t))) {
      const usd = Number(m[1]);
      return rule({ scope, condition: { kind: "amount_over", usd }, action: "escalate" }, `Ask before any single payment over $${usd}.`, text);
    }
    return { intent: "other", summary: "I couldn't turn that into a rule." };
  }
}

function rule(r: Omit<RuleRecord, "id" | "created" | "source" | "type" | "enabled" | "text" | "scope"> & { scope: RuleRecord["scope"] }, summary: string, text: string): OwnerIntent {
  return { intent: "rule", rule: { ...r, text }, summary };
}

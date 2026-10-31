import type { PaymentContext } from "./context.js";
import { groqChat, type GroqConfig } from "./groq.js";
import type { Decision } from "./rules.js";

/**
 * Everything Warden already knows about an alert. The model explains these facts;
 * it never sees anything it could act on, and the decision is made before it is asked.
 */
export interface AlertFacts {
  action: "escalate" | "pause" | "tighten";
  agent: string;
  paymentUsd: number;
  counterparty: string;
  newCounterparty: boolean;
  lookalikeOf?: string;
  agentSpentTodayUsd: number;
  agentNormalDailyUsd: number;
  daysObserved: number;
  riskScore?: number;
  riskFlags?: string[];
  /** Each rule that fired: the owner-readable rule text and what matched. */
  triggers: { rule: string; detail: string }[];
  newCaps?: { per_tx_usd?: number; daily_usd?: number };
  /** For pause/tighten: whether the on-chain action went through. */
  onChain?: "done" | "failed";
}

export interface AlertExplainer {
  /** A short plain-language explanation, or null if none could be produced. */
  explain(facts: AlertFacts): Promise<string | null>;
}

const r2 = (n: number) => Math.round(n * 10_000) / 10_000;

export function alertFacts(ctx: PaymentContext, decision: Decision, action: AlertFacts["action"], onChain?: AlertFacts["onChain"]): AlertFacts {
  return {
    action,
    agent: ctx.agent,
    paymentUsd: r2(ctx.amountUsd),
    counterparty: `${ctx.counterparty.slice(0, 6)}…${ctx.counterparty.slice(-4)}`,
    newCounterparty: ctx.isNewCounterparty,
    ...(ctx.lookalikeOf ? { lookalikeOf: `${ctx.lookalikeOf.slice(0, 6)}…${ctx.lookalikeOf.slice(-4)}` } : {}),
    agentSpentTodayUsd: r2(ctx.dailyUsd),
    agentNormalDailyUsd: r2(ctx.baselineDailyUsd),
    daysObserved: ctx.daysObserved,
    ...(ctx.risk ? { riskScore: ctx.risk.score, riskFlags: ctx.risk.flags } : {}),
    triggers: decision.triggers.map((t) => ({ rule: t.rule.text, detail: t.detail })),
    ...(decision.tighten ? { newCaps: decision.tighten } : {}),
    ...(onChain ? { onChain } : {}),
  };
}

const SYSTEM = `You write the one-paragraph explanation under an alert from Warden, a watchdog that guards the wallets of a person's AI agents on the Sui blockchain.
Warden has already decided and acted; you only explain, for a non-technical owner, why this alert happened and what it means.

Rules:
- At most 2 short sentences, under 50 words, plain text (no markdown, no emoji, no bullet points).
- Name the agent. Only that agent is paused or limited, never the owner's whole wallet.
- Use only the facts given. Never invent amounts, counts, addresses or history. If daysObserved is 0, say Warden has no history for this agent yet rather than calling the payment unusual.
- Compare to the agent's normal spend when that helps; amounts are in US dollars. agentNormalDailyUsd is what it typically spends in a day, not a limit.
- The payment in the facts has already happened on-chain. Never say approving lets it proceed or that declining stops it.
- action "escalate": Warden is asking whether payments like this are OK; say what is unusual. The owner can allow it once, always allow it (Warden stops asking about it), or pause the agent. Do not tell them which to choose.
- action "pause": the agent is frozen on-chain until the owner unpauses it; say why that was the safe move. If onChain is "failed", say the pause did not go through.
- action "tighten": the agent's spending caps were lowered on-chain per the owner's rule.`;

/** Explains alerts with a Groq-hosted model. Short timeout: an alert never waits long for its explanation. */
export class GroqAlertExplainer implements AlertExplainer {
  private readonly cfg: GroqConfig;

  constructor(apiKey: string, model = "openai/gpt-oss-120b", private readonly timeoutMs = 8_000, baseUrl?: string) {
    this.cfg = { apiKey, model, baseUrl };
  }

  async explain(facts: AlertFacts): Promise<string | null> {
    const text = await groqChat(this.cfg, [
      { role: "system", content: SYSTEM },
      { role: "user", content: `Alert facts (JSON):\n${JSON.stringify(facts)}` },
    ], { maxTokens: 300, timeoutMs: this.timeoutMs });
    const clean = text.replace(/[*_`#>]/g, "").replace(/\s+/g, " ").trim();
    return clean ? clean.slice(0, 400) : null;
  }
}

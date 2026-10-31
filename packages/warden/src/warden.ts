import { normalizeSuiAddress } from "@mysten/sui/utils";
import { escapeHtml, type Button, type OwnerChannel, type OwnerInput } from "@warden/bot";
import { parseVaultEvent, queryVaultEvents, type Chain, type EventCursor, type Units, type VaultEvent } from "@warden/shared";
import type { RiskChecker } from "./act/riskcheck.js";
import type { VaultActuator } from "./act/vault.js";
import type { AgentProfile, ConditionKind, Counterparty, Incident, Metric, RuleRecord } from "./memory/schema.js";
import type { WardenMemory } from "./memory/store.js";
import { buildContext, RecentActivity, type PaymentContext, type PaymentEvent } from "./policy/context.js";
import { alertFacts, type AlertExplainer, type AlertFacts } from "./policy/explain.js";
import type { IntentParser, OwnerIntent } from "./policy/parser.js";
import { decide, defaultRules, type Decision } from "./policy/rules.js";

export interface WardenDeps {
  chain: Chain;
  packageId: string;
  vaultId: string;
  units: Units;
  memory: WardenMemory;
  vault: VaultActuator;
  owner: OwnerChannel;
  parser: IntentParser;
  risk?: RiskChecker;
  /** Adds a plain-language "why" under alerts; alerts go out without it if absent or failing. */
  explainer?: AlertExplainer;
  log?: (msg: string) => void;
  /** Approvals of distinct new counterparties before Warden generalises into an allow rule. */
  generaliseAfter?: number;
  now?: () => number;
}

export interface Assessed {
  ctx: PaymentContext;
  decision: Decision;
}

const ESCALATION_DEDUPE_MS = 60 * 60_000;
const CURSOR_CHECKPOINT_MS = 15 * 60_000;
const RULE_SYNC_MS = 10 * 60_000;

const usd = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const day = (ts: number) => new Date(ts).toISOString().slice(0, 10);
const hour = (ts: number) => new Date(ts).toISOString().slice(0, 13);

export class Warden {
  readonly recent = new RecentActivity();
  private cursor: EventCursor = null;
  private lastCursorCheckpoint = 0;
  private lastRuleSync = 0;
  /** Escalation dedupe: agent|counterparty|kinds → last sent. */
  private lastEscalation = new Map<string, number>();
  /** "Allow once" silences the same question until the end of that UTC day. */
  private quietUntil = new Map<string, number>();
  /** Telegram message id → incident id, so a plain reply resolves the right incident. */
  private messageIncident = new Map<number, string>();
  private hourly = new Map<string, { usd: number; payments: number; rejected: number; counterparties: Record<string, number>; txs: string[] }>();
  private daily = new Map<string, { usd: number; hours: Map<string, number> }>();
  private readonly log: (msg: string) => void;
  private readonly now: () => number;

  constructor(private readonly d: WardenDeps) {
    this.log = d.log ?? ((m) => console.log(`[warden] ${m}`));
    this.now = d.now ?? Date.now;
  }

  // ─── lifecycle ──────────────────────────────────────────────────────────

  /** Seeds default rules on first run and restores the observer cursor. */
  async init(): Promise<void> {
    await this.d.memory.load();
    if (this.d.memory.list("rule").length === 0) {
      const merged = await this.d.memory.rebuildFromWalrus(["rule", "agent_profile", "counterparty", "cursor", "metric"]).catch(() => 0);
      if (merged) this.log(`restored ${merged} records from Walrus Memory`);
    }
    if (this.d.memory.list("rule").length === 0) {
      for (const r of defaultRules(new Date(this.now()).toISOString())) this.d.memory.put(r);
      this.log("seeded default (week-1) rules");
    }
    this.cursor = this.d.memory.get("cursor", "observer")?.event_cursor ?? null;
    this.lastCursorCheckpoint = this.now();
  }

  rules(): RuleRecord[] {
    return this.d.memory.list("rule");
  }

  // ─── OBSERVE ────────────────────────────────────────────────────────────

  /** Pulls new SpendVault events via Tatum gRPC (one call covers every agent: all spend through one vault). */
  async observe(maxPages = 4): Promise<VaultEvent[]> {
    const out: VaultEvent[] = [];
    for (let i = 0; i < maxPages; i++) {
      const page = await queryVaultEvents(this.d.chain, this.d.packageId, this.d.vaultId, this.cursor);
      for (const raw of page.data) {
        const ev = parseVaultEvent(raw, this.d.vaultId);
        if (ev) out.push(ev);
      }
      if (page.nextCursor) this.cursor = page.nextCursor;
      if (!page.hasNextPage) break;
    }
    return out;
  }

  // ─── RECALL ─────────────────────────────────────────────────────────────

  /** Makes sure every agent has a profile; re-syncs rules from Walrus so rules added elsewhere (Claude Code) apply. */
  async recall(events: VaultEvent[]): Promise<void> {
    for (const e of events) {
      if (e.kind === "agent_added" || e.kind === "spent" || e.kind === "rejected") this.ensureProfile(e.label, e.agentId);
    }
    if (this.now() - this.lastRuleSync > RULE_SYNC_MS) {
      this.lastRuleSync = this.now();
      try {
        const n = await this.d.memory.rebuildFromWalrus(["rule"], 50);
        if (n) this.log(`picked up ${n} rule change(s) from Walrus Memory`);
      } catch (e) {
        this.log(`rule sync from Walrus failed: ${(e as Error).message}`);
      }
    }
  }

  private ensureProfile(agent: string, agentId: string): AgentProfile {
    const p = this.d.memory.get("agent_profile", agent);
    if (p && p.agent_id === agentId) return p;
    const profile: AgentProfile = p
      ? { ...p, agent_id: agentId }
      : {
          type: "agent_profile",
          agent,
          agent_id: agentId,
          normal_daily_spend_usd: 0,
          days_observed: 0,
          typical_counterparties: [],
          calls_per_hour_p95: 0,
          updated: new Date(this.now()).toISOString(),
        };
    this.d.memory.put(profile);
    return profile;
  }

  // ─── ASSESS ─────────────────────────────────────────────────────────────

  async assess(events: VaultEvent[]): Promise<PaymentContext[]> {
    const out: PaymentContext[] = [];
    for (const e of events) {
      if (e.kind !== "spent" && e.kind !== "rejected") continue;
      if (!this.recent.record(e)) continue; // already processed (replay after restart)
      const cp = normalizeSuiAddress(e.recipient);
      const profile = this.d.memory.get("agent_profile", e.label);
      const isNew = !profile?.typical_counterparties.some((a) => normalizeSuiAddress(a) === cp);
      if (e.kind === "spent" && isNew) await this.maybeRiskCheck(cp);
      out.push(
        buildContext({
          event: e,
          units: this.d.units,
          profile,
          counterparty: this.d.memory.get("counterparty", cp),
          knownCounterparties: this.d.memory.list("counterparty").map((c) => c.address),
          recent: this.recent,
        }),
      );
    }
    return out;
  }

  /** Pays for one x402 risk check per unknown counterparty. */
  private async maybeRiskCheck(cp: string): Promise<void> {
    if (!this.d.risk || this.d.memory.get("counterparty", cp)?.risk_check) return;
    try {
      const r = await this.d.risk.check(cp);
      if (!r) return;
      const existing = this.d.memory.get("counterparty", cp) ?? this.newCounterparty(cp);
      this.d.memory.put({
        ...existing,
        risk_check: { score: r.score, flags: r.flags, checked: new Date(this.now()).toISOString(), paid_tx: r.paidTx },
        trust: Math.min(existing.trust, 1 - r.score),
      });
      this.log(`risk check ${short(cp)}: score ${r.score} (paid via x402, tx ${r.paidTx ?? "?"})`);
    } catch (e) {
      this.log(`risk check failed for ${short(cp)}: ${(e as Error).message}`);
    }
  }

  // ─── DECIDE ─────────────────────────────────────────────────────────────

  decide(contexts: PaymentContext[]): Assessed[] {
    const rules = this.rules();
    return contexts.map((ctx) => ({ ctx, decision: decide(rules, ctx) }));
  }

  // ─── ACT ────────────────────────────────────────────────────────────────

  async act(items: Assessed[]): Promise<void> {
    const metric = this.metric(day(this.now()));
    // A looping agent produces many events per cycle; pause/tighten it at most once.
    const acted = new Set<string>();
    for (const { ctx, decision } of items) {
      if (ctx.event.kind === "spent") metric.events++;
      if (decision.action === "allow") {
        if (ctx.event.kind === "spent") metric.auto_handled++;
        continue;
      }
      const kinds = [...new Set(decision.triggers.map((t) => t.rule.condition.kind))];
      const what = decision.triggers.map((t) => t.detail).join("; ");
      const profile = this.d.memory.get("agent_profile", ctx.agent);
      const agentId = profile?.agent_id ?? ctx.event.agentId;
      if (decision.action !== "escalate") {
        if (acted.has(`${ctx.agent}|${decision.action}`)) continue;
        acted.add(`${ctx.agent}|${decision.action}`);
      }

      if (decision.action === "escalate") {
        const key = escalationKey(ctx.agent, ctx.counterparty, kinds);
        const last = this.lastEscalation.get(key) ?? 0;
        if (this.now() - last < ESCALATION_DEDUPE_MS || this.now() < (this.quietUntil.get(key) ?? 0)) continue;
        this.lastEscalation.set(key, this.now());
        const inc = this.openIncident(ctx, decision, what, kinds, "escalate");
        metric.escalations++;
        const why = await this.explain(inc, alertFacts(ctx, decision, "escalate"));
        const msgId = await this.d.owner.send(
          `❓ <b>${escapeHtml(ctx.agent)}</b>: ${escapeHtml(what)}.\nTx <code>${ctx.event.digest}</code>${why}\nWhat should I do?`,
          incidentButtons(inc.id, false),
        );
        if (msgId) this.messageIncident.set(msgId, inc.id);
      } else if (decision.action === "pause") {
        const res = await this.d.vault.pause(agentId, what).catch((e: Error) => ({ done: false, note: `failed: ${e.message}` }));
        if (!res.done && res.note === "already paused") continue;
        const inc = this.openIncident(ctx, decision, what, kinds, "pause", res.note);
        metric.pauses++;
        // The pause is already on-chain; the explanation only follows it.
        const why = await this.explain(inc, alertFacts(ctx, decision, "pause", res.done ? "done" : "failed"));
        const msgId = await this.d.owner.send(
          `⛔ Paused <b>${escapeHtml(ctx.agent)}</b>: ${escapeHtml(what)}.\nVault tx: <code>${escapeHtml(res.note)}</code>${why}\nIt stays paused until you say so.`,
          incidentButtons(inc.id, true),
        );
        if (msgId) this.messageIncident.set(msgId, inc.id);
      } else if (decision.action === "tighten" && decision.tighten) {
        const res = await this.d.vault.tighten(agentId, decision.tighten).catch((e: Error) => ({ done: false, note: `failed: ${e.message}` }));
        if (!res.done) continue;
        const inc = this.openIncident(ctx, decision, what, kinds, "tighten", res.note);
        this.resolve(inc, "warden", "caps tightened per rule");
        metric.tightens++;
        const why = await this.explain(inc, alertFacts(ctx, decision, "tighten", "done"));
        await this.d.owner.send(`🔒 Tightened <b>${escapeHtml(ctx.agent)}</b> caps (${capText(decision.tighten)}): ${escapeHtml(what)}.\nVault tx: <code>${escapeHtml(res.note)}</code>${why}`);
      }
    }
    this.d.memory.put(metric, { durable: false });
  }

  /**
   * Asks the explainer for a plain-language "why" and keeps it on the incident (so it
   * reaches Walrus Memory). Returns the HTML line to append, or "" when there is none.
   */
  private async explain(inc: Incident, facts: AlertFacts): Promise<string> {
    if (!this.d.explainer) return "";
    const text = await this.d.explainer.explain(facts).catch((e: Error) => {
      this.log(`alert explanation skipped: ${e.message}`);
      return null;
    });
    if (!text) return "";
    this.d.memory.put({ ...(this.d.memory.get("incident", inc.id) ?? inc), explanation: text });
    return `\n💬 ${escapeHtml(text)}`;
  }

  private openIncident(ctx: PaymentContext, decision: Decision, what: string, kinds: ConditionKind[], action: Incident["action"], tx?: string): Incident {
    const inc: Incident = {
      type: "incident",
      id: `inc_${this.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      agent: ctx.agent,
      counterparty: ctx.counterparty,
      what: `${what} (payment ${usd(ctx.amountUsd)}, tx ${ctx.event.digest})`,
      rule_ids: decision.triggers.map((t) => t.rule.id),
      condition_kinds: kinds,
      action,
      tx: tx ?? ctx.event.digest,
      status: "open",
      created: new Date(this.now()).toISOString(),
    };
    this.d.memory.put(inc);
    return inc;
  }

  private resolve(inc: Incident, by: "owner" | "warden", outcome: string): void {
    this.d.memory.put({ ...inc, status: "resolved", resolved_by: by, outcome });
  }

  // ─── LEARN ──────────────────────────────────────────────────────────────

  /** Updates counterparties, baselines and hourly activity; flushes memory to Walrus. */
  async learn(items: Assessed[]): Promise<void> {
    for (const { ctx, decision } of items) {
      const e = ctx.event;
      this.rollup(e, ctx.amountUsd);
      if (e.kind !== "spent") continue;
      const cp = this.d.memory.get("counterparty", ctx.counterparty) ?? this.newCounterparty(ctx.counterparty);
      this.d.memory.put(
        {
          ...cp,
          payments: cp.payments + 1,
          total_usd: cp.total_usd + ctx.amountUsd,
          seen_by: cp.seen_by.includes(ctx.agent) ? cp.seen_by : [...cp.seen_by, ctx.agent],
          trust: decision.action === "allow" ? Math.min(1, cp.trust + 0.02) : cp.trust,
        },
        { durable: cp.payments === 0 }, // first sighting is durable; counters ride on hourly activity
      );
      // A payment Warden allowed (silently or via a learned rule) becomes part of the agent's normal.
      if (decision.action === "allow" && ctx.isNewCounterparty) this.addTypical(ctx.agent, ctx.counterparty);
    }
    this.closeFinishedPeriods();
    if (this.now() - this.lastCursorCheckpoint > CURSOR_CHECKPOINT_MS) {
      this.lastCursorCheckpoint = this.now();
      this.persistProgress();
    } else {
      this.checkpointCursor(false);
    }
    const { ok, failed } = await this.d.memory.flush();
    if (ok || failed) this.log(`walrus memory: ${ok} written, ${failed} queued for retry`);
  }

  private checkpointCursor(durable: boolean): void {
    this.d.memory.put({ type: "cursor", key: "observer", event_cursor: this.cursor, updated: new Date(this.now()).toISOString() }, { durable });
  }

  private newCounterparty(address: string): Counterparty {
    return { type: "counterparty", address, first_seen: new Date(this.now()).toISOString(), seen_by: [], payments: 0, total_usd: 0, trust: 0.5 };
  }

  private addTypical(agent: string, cp: string): void {
    const p = this.d.memory.get("agent_profile", agent);
    if (!p || p.typical_counterparties.includes(cp)) return;
    this.d.memory.put({ ...p, typical_counterparties: [...p.typical_counterparties, cp], updated: new Date(this.now()).toISOString() });
  }

  private rollup(e: PaymentEvent, amountUsd: number): void {
    const hk = `${e.label}|${hour(e.ts)}`;
    const h = this.hourly.get(hk) ?? { usd: 0, payments: 0, rejected: 0, counterparties: {}, txs: [] };
    if (e.kind === "spent") {
      h.usd += amountUsd;
      h.payments++;
      const cp = normalizeSuiAddress(e.recipient);
      h.counterparties[cp] = (h.counterparties[cp] ?? 0) + 1;
      if (h.txs.length < 5) h.txs.push(e.digest);
      const dk = `${e.label}|${day(e.ts)}`;
      const dd = this.daily.get(dk) ?? { usd: 0, hours: new Map() };
      dd.usd += amountUsd;
      dd.hours.set(hour(e.ts), (dd.hours.get(hour(e.ts)) ?? 0) + 1);
      this.daily.set(dk, dd);
    } else {
      h.rejected++;
    }
    this.hourly.set(hk, h);
  }

  /** Writes hourly activity and daily baselines once their period has ended. */
  private closeFinishedPeriods(): void {
    const nowHour = hour(this.now());
    for (const [k, h] of this.hourly) {
      const [agent, hr] = k.split("|") as [string, string];
      if (hr >= nowHour) continue;
      this.d.memory.put({ type: "activity", key: `${agent}:${hr}`, agent, hour: hr, payments: h.payments, usd: h.usd, rejected: h.rejected, counterparties: h.counterparties, sample_txs: h.txs });
      this.hourly.delete(k);
    }
    const today = day(this.now());
    for (const [k, d] of this.daily) {
      const [agent, dy] = k.split("|") as [string, string];
      if (dy >= today) continue;
      const p = this.d.memory.get("agent_profile", agent);
      if (p && p.last_day !== dy) {
        const counts = [...d.hours.values()].sort((a, b) => a - b);
        const p95 = counts[Math.min(counts.length - 1, Math.floor(counts.length * 0.95))] ?? 0;
        this.d.memory.put({
          ...p,
          normal_daily_spend_usd: p.days_observed === 0 ? d.usd : 0.7 * p.normal_daily_spend_usd + 0.3 * d.usd,
          days_observed: p.days_observed + 1,
          calls_per_hour_p95: Math.max(p95, Math.round(0.7 * p.calls_per_hour_p95)),
          last_day: dy,
          updated: new Date(this.now()).toISOString(),
        });
      }
      this.daily.delete(k);
    }
    for (const m of this.d.memory.list("metric")) {
      if (m.day < today && !this.metricsClosed.has(m.day)) {
        this.metricsClosed.add(m.day);
        this.d.memory.put(m); // durable once the day is over
        void this.d.owner.send(this.digest(m.day)).catch(() => {});
      }
    }
  }
  private metricsClosed = new Set<string>();

  /**
   * Writes the observer cursor and today's running counters to Walrus, so a restart on a
   * fresh machine (e.g. a redeploy) resumes both. Called every 15 min and on shutdown.
   */
  persistProgress(): void {
    this.checkpointCursor(true);
    const today = this.d.memory.get("metric", day(this.now()));
    if (today) this.d.memory.put(today);
  }

  private metric(dy: string): Metric {
    return this.d.memory.get("metric", dy) ?? { type: "metric", day: dy, events: 0, auto_handled: 0, escalations: 0, pauses: 0, tightens: 0, rules_learned: 0 };
  }

  // ─── Owner input (the only human touchpoint) ────────────────────────────

  async handleOwner(input: OwnerInput): Promise<string> {
    if (input.kind === "button") {
      const [, id, choice] = input.data.split(":");
      const inc = id ? this.d.memory.get("incident", id) : undefined;
      if (!inc) return "That incident is no longer open.";
      const choices = { once: "allow_once", always: "always_allow", pause: "pause", unpause: "unpause", keep: "keep" } as const;
      const decision = choices[choice as keyof typeof choices];
      if (!decision) return "Unknown choice.";
      if (decision === "keep") {
        this.recordFeedback(inc, "keep paused");
        this.resolve(inc, "owner", "owner kept agent paused");
        return `${inc.agent} stays paused.`;
      }
      return this.applyResolution(inc, decision, `[button] ${choice}`);
    }

    const text = input.text.trim();
    if (text.startsWith("/")) return this.command(text);

    const replyInc = input.replyToMessageId ? this.messageIncident.get(input.replyToMessageId) : undefined;
    const incident = (replyInc && this.d.memory.get("incident", replyInc)) || this.latestOpenIncident();
    let intent: OwnerIntent;
    try {
      intent = await this.d.parser.parse(text, {
        agents: this.d.memory.list("agent_profile").map((p) => p.agent),
        incident: incident?.status === "open" ? incident : undefined,
      });
    } catch (e) {
      return `I couldn't parse that right now (${(e as Error).message}). Try again in a moment.`;
    }
    if (intent.intent === "resolve" && incident) return this.applyResolution(incident, intent.decision, text);
    if (intent.intent === "rule") {
      const rule = this.addRule({ ...intent.rule, text }, "telegram");
      const applied = await this.applyTightenNow(rule);
      return `Got it — <b>${rule.id}</b>: ${escapeHtml(intent.summary)}${applied}\nSaved to Walrus Memory. /undo ${rule.id} to remove.`;
    }
    return escapeHtml(intent.summary);
  }

  private async applyResolution(inc: Incident, decision: "allow_once" | "always_allow" | "pause" | "unpause", reply: string): Promise<string> {
    const agentId = this.d.memory.get("agent_profile", inc.agent)?.agent_id;
    switch (decision) {
      case "allow_once": {
        const endOfDay = Math.floor(this.now() / 86_400_000 + 1) * 86_400_000;
        this.quietUntil.set(escalationKey(inc.agent, inc.counterparty, inc.condition_kinds), endOfDay);
        this.recordFeedback(inc, reply);
        this.resolve(inc, "owner", "approved once");
        return `OK, allowed. I won't ask about this again today.`;
      }
      case "always_allow": {
        const scope = { agent: inc.agent, ...(inc.counterparty ? { counterparty: inc.counterparty } : {}) };
        const kind = (inc.condition_kinds[0] ?? "new_counterparty") as ConditionKind;
        const rule = this.addRule(
          {
            text: `Always allow ${inc.agent} → ${inc.counterparty ? short(inc.counterparty) : "this"} for ${kind.replace(/_/g, " ")} (learned from ${inc.id})`,
            scope,
            condition: conditionFor(kind, inc),
            action: "allow",
          },
          "feedback",
          inc.id,
        );
        if (inc.counterparty) this.addTypical(inc.agent, inc.counterparty);
        this.recordFeedback(inc, reply, rule.id);
        this.resolve(inc, "owner", `always allow → ${rule.id}`);
        if (inc.action === "pause" && agentId) await this.d.vault.unpause(agentId).catch(() => {});
        const general = this.maybeGeneralise(inc);
        return `Learned <b>${rule.id}</b>: I won't ask about this again.${general}`;
      }
      case "pause": {
        if (!agentId) return `I don't know ${inc.agent}'s vault id yet.`;
        const r = await this.d.vault.pause(agentId, `owner: ${reply}`);
        this.recordFeedback(inc, reply);
        this.resolve(inc, "owner", "owner paused agent");
        return `Paused ${inc.agent} (${r.note}).`;
      }
      case "unpause": {
        if (!agentId) return `I don't know ${inc.agent}'s vault id yet.`;
        const r = await this.d.vault.unpause(agentId);
        this.recordFeedback(inc, reply);
        this.resolve(inc, "owner", "owner resumed agent");
        return `Resumed ${inc.agent} (${r.note}).`;
      }
    }
  }

  /**
   * After N owner approvals of distinct new counterparties for one agent, learn the
   * pattern: allow that agent's new counterparties up to 1.5× the largest approved amount.
   */
  private maybeGeneralise(inc: Incident): string {
    if (!inc.condition_kinds.includes("new_counterparty")) return "";
    const approvals = this.d.memory
      .list("rule")
      .filter((r) => r.source === "feedback" && r.action === "allow" && r.scope.agent === inc.agent && r.scope.counterparty && r.condition.kind === "new_counterparty");
    const already = this.d.memory.list("rule").some((r) => r.action === "allow" && r.scope.agent === inc.agent && !r.scope.counterparty && r.condition.kind === "new_counterparty" && r.enabled);
    if (already || approvals.length < (this.d.generaliseAfter ?? 3)) return "";
    const amounts = approvals
      .map((r) => this.d.memory.get("incident", r.learned_from ?? "")?.what.match(/payment \$(\d+(?:\.\d+)?)/)?.[1])
      .filter(Boolean)
      .map(Number);
    if (!amounts.length) return "";
    const cap = Math.ceil(Math.max(...amounts) * 1.5 * 1000) / 1000;
    const rule = this.addRule(
      {
        text: `${inc.agent} may pay new counterparties up to $${cap} without asking (generalised from ${approvals.length} approvals)`,
        scope: { agent: inc.agent },
        condition: { kind: "new_counterparty" },
        amount_max_usd: cap,
        action: "allow",
      },
      "feedback",
      inc.id,
    );
    return `\n\n🧠 You've approved ${approvals.length} new counterparties for ${escapeHtml(inc.agent)}, all small. New rule <b>${rule.id}</b>: ${escapeHtml(inc.agent)} may pay new counterparties up to $${cap} without asking. /undo ${rule.id} if that's wrong.`;
  }

  private addRule(r: Pick<RuleRecord, "text" | "scope" | "condition" | "action"> & Partial<RuleRecord>, source: RuleRecord["source"], learnedFrom?: string): RuleRecord {
    const n = this.d.memory.list("rule").filter((x) => x.source !== "default").length + 1;
    const rule: RuleRecord = {
      ...r,
      type: "rule",
      id: `rule_${String(n).padStart(3, "0")}`,
      source,
      created: new Date(this.now()).toISOString(),
      enabled: true,
      ...(learnedFrom ? { learned_from: learnedFrom } : {}),
    };
    this.d.memory.put(rule);
    const m = this.metric(day(this.now()));
    m.rules_learned++;
    this.d.memory.put(m, { durable: false });
    return rule;
  }

  /** A new tighten rule takes effect on-chain right away for every agent it covers. */
  private async applyTightenNow(rule: RuleRecord): Promise<string> {
    if (rule.action !== "tighten" || !rule.tighten) return "";
    const agents = this.d.memory.list("agent_profile").filter((p) => !rule.scope.agent || p.agent === rule.scope.agent);
    const notes: string[] = [];
    for (const p of agents) {
      const r = await this.d.vault.tighten(p.agent_id, rule.tighten).catch((e: Error) => ({ done: false, note: e.message }));
      notes.push(`${p.agent}: ${r.done ? `tx ${r.note}` : r.note}`);
    }
    return notes.length ? `\nApplied on-chain now — ${escapeHtml(notes.join("; "))}` : "";
  }

  private recordFeedback(inc: Incident, reply: string, ruleChange?: string): void {
    this.d.memory.put({
      type: "feedback",
      id: `fb_${this.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      incident: inc.id,
      decision: inc.action,
      owner_reply: reply,
      ...(ruleChange ? { rule_change: ruleChange } : {}),
      created: new Date(this.now()).toISOString(),
    });
  }

  private latestOpenIncident(): Incident | undefined {
    return this.d.memory
      .list("incident")
      .filter((i) => i.status === "open")
      .sort((a, b) => b.created.localeCompare(a.created))[0];
  }

  private async command(text: string): Promise<string> {
    const [cmd, arg] = text.split(/\s+/, 2);
    switch (cmd) {
      case "/rules":
        return this.rules()
          .filter((r) => r.enabled)
          .map((r) => `• <b>${r.id}</b> [${r.source}] ${escapeHtml(r.text)} → ${r.action}`)
          .join("\n");
      case "/undo": {
        const r = arg ? this.d.memory.get("rule", arg) : undefined;
        if (!r) return "Usage: /undo rule_007";
        this.d.memory.put({ ...r, enabled: false });
        return `Disabled ${r.id}.`;
      }
      case "/status": {
        const agents = await this.d.vault.agents().catch(() => []);
        const s = this.d.memory.stats();
        const credits = this.d.chain.meter.snapshot();
        return [
          ...agents.map((a) => `• <b>${escapeHtml(a.label)}</b> ${a.paused ? "⛔ paused" : "✅ active"} — today ${usd(this.d.units.toUsd(a.spentToday))} / ${usd(this.d.units.toUsd(a.dailyCap))}`),
          `Memory: ${s.records} records, ${s.walrusWrites} written to Walrus, ${s.pending} pending.`,
          `Tatum credits today: ${credits.credits}.`,
        ].join("\n");
      }
      case "/digest":
        return this.digest(day(this.now()));
      case "/unpause": {
        const p = arg ? this.d.memory.get("agent_profile", arg) : undefined;
        if (!p) return "Usage: /unpause <agent>";
        const r = await this.d.vault.unpause(p.agent_id);
        return `Resumed ${p.agent} (${r.note}).`;
      }
      default:
        return "Commands: /status, /rules, /digest, /undo &lt;rule&gt;, /unpause &lt;agent&gt;. Or just tell me a rule in plain English.";
    }
  }

  digest(dy: string): string {
    const m = this.metric(dy);
    const learned = this.rules().filter((r) => r.source !== "default" && r.created.startsWith(dy));
    return [
      `📒 <b>Warden digest ${dy}</b>`,
      `${m.events} payments watched, ${m.auto_handled} handled silently, ${m.escalations} questions to you, ${m.pauses} pauses, ${m.tightens} cap changes.`,
      learned.length ? `Learned today: ${learned.map((r) => r.id).join(", ")}.` : "No new rules today.",
    ].join("\n");
  }
}

function escalationKey(agent: string, counterparty: string | undefined, kinds: string[]): string {
  return `${agent}|${counterparty ?? ""}|${kinds.join(",")}`;
}

function incidentButtons(id: string, paused: boolean): Button[][] {
  return paused
    ? [[{ text: "Keep paused", data: `inc:${id}:keep` }, { text: "Unpause", data: `inc:${id}:unpause` }], [{ text: "Unpause + always allow", data: `inc:${id}:always` }]]
    : [[{ text: "Allow once", data: `inc:${id}:once` }, { text: "Always allow", data: `inc:${id}:always` }], [{ text: "Pause agent", data: `inc:${id}:pause` }]];
}

function capText(t: { per_tx_usd?: number; daily_usd?: number }): string {
  return [t.per_tx_usd !== undefined && `per-tx ${usd(t.per_tx_usd)}`, t.daily_usd !== undefined && `daily ${usd(t.daily_usd)}`].filter(Boolean).join(", ");
}

/** Builds the allow-rule condition mirroring the one that fired. */
function conditionFor(kind: ConditionKind, _inc: Incident): RuleRecord["condition"] {
  switch (kind) {
    case "velocity":
      return { kind, count: 1, window_min: 1 };
    case "amount_over":
    case "daily_over":
      return { kind, usd: 0 };
    case "baseline_spike":
      return { kind, factor: 1 };
    case "rejected_burst":
      return { kind, count: 1, window_min: 1 };
    case "risky_counterparty":
      return { kind, min_score: 0 };
    default:
      return { kind } as RuleRecord["condition"];
  }
}

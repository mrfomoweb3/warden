/**
 * "Try Warden": visitors sign in with a Sui wallet, name an agent, set rules in plain
 * English and link their own Telegram chat. They run in SHADOW MODE: their rules are
 * evaluated with the real policy engine on the real payments of one demo agent, and
 * Warden tells them what it would do. Nothing a visitor does reaches the vault; only
 * the owner's chat steers the real Warden.
 *
 * State lives in a local JSON file and is mirrored to Walrus Memory (its own
 * namespace), so visitors survive restarts and a fresh machine.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isValidSuiAddress, normalizeSuiAddress } from "@mysten/sui/utils";
import { verifyPersonalMessageSignature } from "@mysten/sui/verify";
import { escapeHtml, type Button, type OwnerInput, type VisitorReply } from "@warden/bot";
import { RuleRecord } from "./memory/schema.js";
import type { MemoryBackend } from "./memory/store.js";
import type { PaymentContext } from "./policy/context.js";
import { alertFacts, type AlertExplainer } from "./policy/explain.js";
import type { IntentParser } from "./policy/parser.js";
import { decide, defaultRules } from "./policy/rules.js";

type VerifyClient = NonNullable<Parameters<typeof verifyPersonalMessageSignature>[2]>["client"];

export interface Visitor {
  address: string;
  /** The visitor's own name for their agent. */
  agentName: string;
  /** The demo agent whose real payments their rules are evaluated on. */
  watches: string;
  rules: RuleRecord[];
  chatId?: string;
  nextRule: number;
  /** Bumped on every save, so a restore from Walrus keeps the newest copy even within one millisecond. */
  rev: number;
  created: string;
  updated: string;
}

/** A serialisable copy of a PaymentContext: what the rules test, frozen at payment time. */
interface Snapshot {
  event: PaymentContext["event"];
  agent: string;
  counterparty: string;
  amountUsd: number;
  dailyUsd: number;
  isNewCounterparty: boolean;
  lookalikeOf?: string;
  baselineDailyUsd: number;
  daysObserved: number;
  risk?: { score: number; flags: string[] };
  /** Payments to this counterparty / vault refusals within each window (minutes). */
  velocity: Record<number, number>;
  rejected: Record<number, number>;
}

export interface ReplayItem {
  ts: number;
  digest: string;
  amountUsd: number;
  counterparty: string;
  action: "allow" | "escalate" | "tighten" | "pause";
  why: string[];
  /** Ids of the visitor's allow rules that silenced a trigger. */
  silencedBy: string[];
}

export interface VisitorDeps {
  stateFile: string | null;
  backend?: MemoryBackend;
  parser: IntentParser;
  explainer?: AlertExplainer;
  /** Verifies wallet signatures (needed for zkLogin wallets such as Slush with Google). */
  client?: VerifyClient;
  /** Demo agents a visitor may watch. */
  agents: () => string[];
  /** Sends a Telegram message to a visitor's chat. */
  send?: (chatId: string, text: string, buttons?: Button[][]) => Promise<unknown>;
  network: string;
  siteUrl: string;
  /** HMAC key for session tokens; a random one per process is fine (sessions end on restart). */
  secret?: string;
  log?: (msg: string) => void;
  now?: () => number;
}

const WINDOWS = [5, 10, 15, 30, 60, 120, 360, 1440];
const MAX_VISITORS = 300;
const MAX_RULES = 10;
const PARSES_PER_HOUR = 30;
const ALERT_DEDUPE_MS = 60 * 60_000;
const ALERT_MIN_GAP_MS = 20_000;
const ALERTS_PER_DAY = 30;
const NONCE_TTL_MS = 5 * 60_000;
const LINK_TTL_MS = 15 * 60_000;
const TOKEN_TTL_MS = 7 * 24 * 3_600_000;
const RING = 60;
const MARKER = "\n---warden-visitor---\n";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const usd = (n: number) => `$${n.toFixed(n < 1 ? 3 : 2)}`;
const b64url = (b: Buffer) => b.toString("base64url");

export class VisitorError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** Smallest precomputed window that covers `w` minutes: never under-counts a burst. */
function lookup(counts: Record<number, number>, w: number): number {
  const win = WINDOWS.find((x) => x >= w) ?? WINDOWS[WINDOWS.length - 1]!;
  return counts[win] ?? 0;
}

export function snapshot(ctx: PaymentContext): Snapshot {
  return {
    event: ctx.event,
    agent: ctx.agent,
    counterparty: ctx.counterparty,
    amountUsd: ctx.amountUsd,
    dailyUsd: ctx.dailyUsd,
    isNewCounterparty: ctx.isNewCounterparty,
    ...(ctx.lookalikeOf ? { lookalikeOf: ctx.lookalikeOf } : {}),
    baselineDailyUsd: ctx.baselineDailyUsd,
    daysObserved: ctx.daysObserved,
    ...(ctx.risk ? { risk: ctx.risk } : {}),
    velocity: Object.fromEntries(WINDOWS.map((w) => [w, ctx.velocity(w)])),
    rejected: Object.fromEntries(WINDOWS.map((w) => [w, ctx.rejectedCount(w)])),
  };
}

function revive(s: Snapshot): PaymentContext {
  return {
    ...s,
    event: { ...s.event, amount: BigInt(String(s.event.amount)) } as PaymentContext["event"],
    velocity: (w: number) => lookup(s.velocity, w),
    rejectedCount: (w: number) => lookup(s.rejected, w),
  } as PaymentContext;
}

export class VisitorRegistry {
  private visitors = new Map<string, Visitor>();
  private ring: Snapshot[] = [];
  private nonces = new Map<string, number>();
  private links = new Map<string, { address: string; exp: number }>();
  private parses = new Map<string, number[]>();
  /** Alerts awaiting a button press: id → what the visitor is answering. */
  private alerts = new Map<string, { address: string; agent: string; counterparty: string; conditions: RuleRecord["condition"][] }>();
  private lastAlert = new Map<string, number>();
  private alertLog = new Map<string, number[]>();
  private botUsername: string | null = null;
  private readonly secret: Buffer;
  private readonly log: (msg: string) => void;
  private readonly now: () => number;

  constructor(private readonly d: VisitorDeps) {
    this.secret = d.secret ? Buffer.from(d.secret) : randomBytes(32);
    this.log = d.log ?? ((m) => console.log(`[visitors] ${m}`));
    this.now = d.now ?? Date.now;
  }

  setBotUsername(username: string): void {
    this.botUsername = username;
  }

  // ─── persistence ────────────────────────────────────────────────────────

  /** Loads the local file; if there is none (a fresh machine), rebuilds from Walrus Memory. */
  async init(): Promise<void> {
    const local = this.d.stateFile ? await readFile(this.d.stateFile, "utf8").then(JSON.parse).catch(() => null) : null;
    if (local) {
      for (const v of local.visitors ?? []) this.visitors.set(v.address, this.clean(v));
      this.ring = (local.ring ?? []).slice(-RING);
      return;
    }
    if (!this.d.backend) return;
    try {
      const hits = await this.d.backend.recall("Warden visitor shadow-mode rules", 200);
      for (const h of hits) {
        const i = h.text.indexOf(MARKER);
        if (i < 0) continue;
        const v = this.clean(JSON.parse(h.text.slice(i + MARKER.length)));
        const prev = this.visitors.get(v.address);
        if (!prev || prev.rev < v.rev) this.visitors.set(v.address, v);
      }
      if (this.visitors.size) this.log(`restored ${this.visitors.size} visitors from Walrus Memory`);
    } catch (e) {
      this.log(`could not restore visitors from Walrus: ${(e as Error).message}`);
    }
  }

  /** Re-validates every rule, so a bad record can never reach the policy engine. */
  private clean(v: Visitor): Visitor {
    const rules = (v.rules ?? []).flatMap((r) => {
      const p = RuleRecord.safeParse(r);
      return p.success ? [p.data] : [];
    });
    return { ...v, address: normalizeSuiAddress(v.address), rules, nextRule: v.nextRule ?? rules.length + 1, rev: v.rev ?? 0 };
  }

  private async save(changed?: Visitor): Promise<void> {
    if (changed) changed.rev++;
    if (this.d.stateFile) {
      const tmp = `${this.d.stateFile}.tmp`;
      await mkdir(dirname(this.d.stateFile), { recursive: true });
      await writeFile(tmp, JSON.stringify({ visitors: [...this.visitors.values()], ring: this.ring }, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
      await rename(tmp, this.d.stateFile);
    }
    if (changed && this.d.backend) {
      const v = changed;
      const text =
        `Warden visitor ${short(v.address)} (shadow-mode rules): agent "${v.agentName || "unnamed"}" watching ${v.watches}; ` +
        `${v.rules.length} rule${v.rules.length === 1 ? "" : "s"}${v.rules.length ? `: ${v.rules.map((r) => r.text).join("; ")}` : ""}.` +
        MARKER +
        JSON.stringify(v);
      await this.d.backend.write(text, `warden:visitor:${v.address}:${v.rev}`).catch((e: Error) => this.log(`walrus write failed: ${e.message}`));
    }
  }

  // ─── sign-in ────────────────────────────────────────────────────────────

  /** A one-time message for the wallet to sign. Signing costs nothing and moves no funds. */
  issueNonce(): { message: string } {
    for (const [n, exp] of this.nonces) if (exp < this.now()) this.nonces.delete(n);
    const nonce = b64url(randomBytes(12));
    this.nonces.set(nonce, this.now() + NONCE_TTL_MS);
    return {
      message:
        `Sign in to Warden (Sui ${this.d.network} demo).\n\n` +
        `This proves you own this address. It costs nothing and moves no funds.\n\n` +
        `Nonce: ${nonce}\nIssued: ${new Date(this.now()).toISOString()}`,
    };
  }

  async login(address: string, message: string, signature: string): Promise<{ token: string; address: string }> {
    if (!isValidSuiAddress(address)) throw new VisitorError("That isn't a Sui address.");
    const nonce = /Nonce: ([\w-]+)/.exec(message)?.[1];
    const exp = nonce ? this.nonces.get(nonce) : undefined;
    if (!nonce || !exp || exp < this.now()) throw new VisitorError("This sign-in request expired. Please try again.", 401);
    this.nonces.delete(nonce); // single use
    try {
      await verifyPersonalMessageSignature(new TextEncoder().encode(message), signature, { address: normalizeSuiAddress(address), client: this.d.client });
    } catch {
      throw new VisitorError("The signature doesn't match this address.", 401);
    }
    const addr = normalizeSuiAddress(address);
    if (!this.visitors.has(addr)) {
      if (this.visitors.size >= MAX_VISITORS) throw new VisitorError("The demo is full right now. Please try again later.", 503);
      const t = new Date(this.now()).toISOString();
      const v: Visitor = { address: addr, agentName: "", watches: this.d.agents()[0] ?? "pricebot", rules: [], nextRule: 1, rev: 0, created: t, updated: t };
      this.visitors.set(addr, v);
      await this.save(v);
    }
    const until = this.now() + TOKEN_TTL_MS;
    const body = `${addr}.${until}`;
    return { token: `${body}.${this.sign(body)}`, address: addr };
  }

  private sign(body: string): string {
    return b64url(createHmac("sha256", this.secret).update(body).digest());
  }

  /** Returns the visitor a session token belongs to, or throws 401. */
  authenticate(token: string | undefined): Visitor {
    const [addr, until, mac] = (token ?? "").split(".");
    const good = addr && until && mac ? this.sign(`${addr}.${until}`) : "";
    if (!good || good.length !== mac!.length || !timingSafeEqual(Buffer.from(good), Buffer.from(mac!)) || Number(until) < this.now()) {
      throw new VisitorError("Please connect your wallet again.", 401);
    }
    const v = this.visitors.get(addr!);
    if (!v) throw new VisitorError("Please connect your wallet again.", 401);
    return v;
  }

  // ─── agent and rules ────────────────────────────────────────────────────

  async setAgent(v: Visitor, name: string, watches: string): Promise<Visitor> {
    const clean = name.trim();
    if (!/^[\w .-]{1,32}$/.test(clean)) throw new VisitorError("Use 1-32 letters, numbers, spaces, dots or dashes for the name.");
    if (!this.d.agents().includes(watches)) throw new VisitorError(`Pick one of the demo agents: ${this.d.agents().join(", ")}.`);
    v.agentName = clean;
    // Rules follow the agent: re-scope them if the watched agent changes.
    if (v.watches !== watches) v.rules = v.rules.map((r) => ({ ...r, scope: { ...r.scope, agent: watches } }));
    v.watches = watches;
    v.updated = new Date(this.now()).toISOString();
    await this.save(v);
    return v;
  }

  /** Parses a plain-English rule with Warden's real parser and saves it for this visitor. */
  async addRule(v: Visitor, text: string): Promise<{ rule: RuleRecord; summary: string }> {
    const t = text.trim();
    if (t.length < 4 || t.length > 200) throw new VisitorError("Write the rule in a short sentence (up to 200 characters).");
    if (v.rules.length >= MAX_RULES) throw new VisitorError(`You can keep up to ${MAX_RULES} rules. Delete one first.`);
    const recent = (this.parses.get(v.address) ?? []).filter((ts) => ts > this.now() - 3_600_000);
    if (recent.length >= PARSES_PER_HOUR) throw new VisitorError("That's a lot of rules for one hour. Try again later.", 429);
    this.parses.set(v.address, [...recent, this.now()]);

    const intent = await this.d.parser.parse(t, { agents: [v.watches] });
    if (intent.intent !== "rule") {
      throw new VisitorError(`I couldn't turn that into a rule (${intent.summary}). Try e.g. "ask me before any new counterparty over $0.01".`);
    }
    const rule = RuleRecord.parse({
      ...intent.rule,
      type: "rule",
      id: `v${v.nextRule}`,
      text: t,
      scope: { ...intent.rule.scope, agent: v.watches },
      source: "telegram",
      created: new Date(this.now()).toISOString(),
      enabled: true,
    });
    v.nextRule++;
    v.rules.push(rule);
    v.updated = rule.created;
    await this.save(v);
    return { rule, summary: intent.summary };
  }

  async deleteRule(v: Visitor, id: string): Promise<void> {
    const before = v.rules.length;
    v.rules = v.rules.filter((r) => r.id !== id);
    if (v.rules.length === before) throw new VisitorError("No such rule.", 404);
    v.updated = new Date(this.now()).toISOString();
    await this.save(v);
  }

  // ─── Telegram link ──────────────────────────────────────────────────────

  telegramLink(v: Visitor): { link: string } {
    if (!this.botUsername) throw new VisitorError("Telegram isn't connected on this server.", 503);
    for (const [c, l] of this.links) if (l.exp < this.now()) this.links.delete(c);
    const code = b64url(randomBytes(9));
    this.links.set(code, { address: v.address, exp: this.now() + LINK_TTL_MS });
    return { link: `https://t.me/${this.botUsername}?start=${code}` };
  }

  // ─── shadow evaluation ──────────────────────────────────────────────────

  private rulesFor(v: Visitor): RuleRecord[] {
    return [...defaultRules(), ...v.rules];
  }

  /** Called after each Warden cycle with the payments it assessed. Never touches the vault. */
  async observe(contexts: PaymentContext[]): Promise<void> {
    if (!contexts.length) return;
    const snaps = contexts.map(snapshot);
    this.ring = [...this.ring, ...snaps].slice(-RING);
    for (const s of snaps) {
      const ctx = revive(s);
      for (const v of this.visitors.values()) {
        if (!v.chatId || v.watches !== ctx.agent) continue;
        const decision = decide(this.rulesFor(v), ctx);
        if (decision.action === "allow") continue;
        await this.alert(v, ctx, decision).catch((e: Error) => this.log(`alert to ${short(v.address)} failed: ${e.message}`));
      }
    }
    await this.save();
  }

  private async alert(v: Visitor, ctx: PaymentContext, decision: ReturnType<typeof decide>): Promise<void> {
    if (!this.d.send || !v.chatId) return;
    const kinds = [...new Set(decision.triggers.map((t) => t.rule.condition.kind))].sort();
    const key = `${v.address}|${ctx.counterparty}|${kinds.join(",")}`;
    const t = this.now();
    if (t - (this.lastAlert.get(key) ?? 0) < ALERT_DEDUPE_MS) return;
    const today = (this.alertLog.get(v.address) ?? []).filter((x) => x > t - 86_400_000);
    if (today.length >= ALERTS_PER_DAY || t - (today[today.length - 1] ?? 0) < ALERT_MIN_GAP_MS) return;
    this.lastAlert.set(key, t);
    this.alertLog.set(v.address, [...today, t]);

    const what = decision.triggers.map((x) => x.detail).join("; ");
    const verb = { escalate: "ask you", pause: "pause it", tighten: "lower its caps", allow: "allow it" }[decision.action];
    const icon = { escalate: "❓", pause: "⛔", tighten: "🔒", allow: "✓" }[decision.action];
    const tx = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(ctx.event.digest)
      ? `<a href="https://suiscan.xyz/${this.d.network}/tx/${ctx.event.digest}">${short(ctx.event.digest)}</a>`
      : escapeHtml(ctx.event.digest);
    let why = "";
    if (this.d.explainer && decision.action !== "allow") {
      const text = await this.d.explainer.explain(alertFacts(ctx, decision, decision.action)).catch(() => null);
      if (text) why = `\n💬 ${escapeHtml(text)}`;
    }
    const id = b64url(randomBytes(6));
    this.alerts.set(id, { address: v.address, agent: ctx.agent, counterparty: ctx.counterparty, conditions: decision.triggers.map((x) => x.rule.condition) });
    if (this.alerts.size > 2000) this.alerts.delete(this.alerts.keys().next().value!);
    await this.d.send(
      v.chatId,
      `🧪 <b>${escapeHtml(v.agentName || "Your agent")}</b> (watching ${escapeHtml(v.watches)}, shadow mode)\n` +
        `${icon} Under your rules Warden would <b>${verb}</b>: ${escapeHtml(what)}.\nTx ${tx}${why}\n` +
        `<i>Your answer only changes your rules. The real vault stays with its owner.</i>`,
      [[{ text: "Allow once", data: `v:${id}:once` }, { text: "Always allow", data: `v:${id}:always` }]],
    );
  }

  /** What Warden would have done, under this visitor's rules, on the watched agent's recent real payments. */
  replay(v: Visitor, limit = 12): ReplayItem[] {
    return this.ring
      .filter((s) => s.agent === v.watches)
      .slice(-limit)
      .reverse()
      .map((s) => {
        const ctx = revive(s);
        const d = decide(this.rulesFor(v), ctx);
        return {
          ts: ctx.event.ts,
          digest: ctx.event.digest,
          amountUsd: ctx.amountUsd,
          counterparty: ctx.counterparty,
          action: d.action,
          why: d.triggers.map((t) => t.detail),
          silencedBy: [...new Set(d.suppressed.map((x) => x.by).filter((id) => !id.startsWith("default_")))],
        };
      });
  }

  view(v: Visitor) {
    return {
      address: v.address,
      agentName: v.agentName,
      watches: v.watches,
      agents: this.d.agents(),
      rules: v.rules.map((r) => ({ id: r.id, text: r.text, action: r.action, condition: r.condition, created: r.created })),
      defaults: defaultRules().map((r) => ({ id: r.id, text: r.text, action: r.action })),
      telegram: { linked: Boolean(v.chatId), available: Boolean(this.botUsername) },
      network: this.d.network,
    };
  }

  // ─── Telegram chats ─────────────────────────────────────────────────────

  private byChat(chatId: string): Visitor | undefined {
    for (const v of this.visitors.values()) if (v.chatId === chatId) return v;
    return undefined;
  }

  /** Every non-owner Telegram chat lands here. */
  async handleChat(chatId: string, input: OwnerInput): Promise<VisitorReply> {
    const welcome = `Hi! I'm Warden, a watchdog for AI agents' wallets on Sui.\nTry me at ${this.d.siteUrl}/try: connect a wallet, name an agent, set a rule, then link this chat.`;
    if (input.kind === "text") {
      const text = input.text.trim();
      const start = /^\/start(?:\s+([\w-]+))?$/.exec(text);
      if (start) return start[1] ? this.link(chatId, start[1]) : welcome;
      const v = this.byChat(chatId);
      if (!v) return welcome;
      if (text === "/rules") {
        return v.rules.length
          ? `Your rules (shadow mode, on ${escapeHtml(v.watches)}):\n${v.rules.map((r) => `• <code>${r.id}</code> ${escapeHtml(r.text)} → ${r.action}`).join("\n")}`
          : `You have no rules yet, so the week-one defaults apply. Type one, e.g. "ask me before any new counterparty over $0.01".`;
      }
      if (text === "/stop") {
        delete v.chatId;
        v.updated = new Date(this.now()).toISOString();
        await this.save(v);
        return "Unlinked. I won't message this chat again. You can link again from the site.";
      }
      if (text.startsWith("/")) return "Commands: /rules, /stop. Or type a rule in plain English.";
      try {
        const { rule, summary } = await this.addRule(v, text);
        return `Saved <code>${rule.id}</code>: ${escapeHtml(summary)} → ${rule.action}. It applies to ${escapeHtml(v.watches)}'s real payments from now on.`;
      } catch (e) {
        return escapeHtml((e as Error).message);
      }
    }
    const m = /^v:([\w-]+):(once|always)$/.exec(input.data);
    const a = m ? this.alerts.get(m[1]!) : undefined;
    const v = this.byChat(chatId);
    if (!m || !a || !v || v.address !== a.address) return "That question has expired.";
    if (m[2] === "once") return "OK, allowed this once. I'll ask again next time.";
    if (v.rules.length + a.conditions.length > MAX_RULES) return `You can keep up to ${MAX_RULES} rules. Send /rules to see them.`;
    const created = new Date(this.now()).toISOString();
    const learned = a.conditions.map((condition) => {
      const rule = RuleRecord.parse({
        type: "rule",
        id: `v${v.nextRule++}`,
        text: `Always allow ${a.agent} → ${short(a.counterparty)} (${condition.kind.replaceAll("_", " ")})`,
        scope: { agent: a.agent, counterparty: a.counterparty },
        condition,
        action: "allow",
        source: "feedback",
        created,
        enabled: true,
        learned_from: m[1],
      });
      v.rules.push(rule);
      return rule;
    });
    v.updated = created;
    await this.save(v);
    this.alerts.delete(m[1]!);
    return `Learned ${learned.map((r) => `<code>${r.id}</code>`).join(", ")}: I won't ask about ${short(a.counterparty)} again.`;
  }

  private async link(chatId: string, code: string): Promise<string> {
    const l = this.links.get(code);
    if (!l || l.exp < this.now()) return `That link has expired. Get a new one at ${this.d.siteUrl}/try.`;
    this.links.delete(code);
    for (const other of this.visitors.values()) if (other.chatId === chatId) delete other.chatId;
    const v = this.visitors.get(l.address);
    if (!v) return `Please connect your wallet again at ${this.d.siteUrl}/try.`;
    v.chatId = chatId;
    v.updated = new Date(this.now()).toISOString();
    await this.save(v);
    return (
      `Linked to ${short(v.address)}. You're watching <b>${escapeHtml(v.watches)}</b> as "${escapeHtml(v.agentName || "your agent")}".\n` +
      `When one of its real payments trips your rules, I'll message you here. You're in shadow mode: your answers change only your rules, never the real vault.\n` +
      `Type a rule in plain English any time, or send /rules or /stop.`
    );
  }

  /** For tests: the visitor a session belongs to. */
  get(address: string): Visitor | undefined {
    return this.visitors.get(normalizeSuiAddress(address));
  }

  /** Demo totals shown on the dashboard. */
  stats(): { visitors: number; linked: number } {
    let linked = 0;
    for (const v of this.visitors.values()) if (v.chatId) linked++;
    return { visitors: this.visitors.size, linked };
  }

  /** Formats a replay amount for messages. */
  static money = usd;
}

import { normalizeSuiAddress } from "@mysten/sui/utils";
import type { Units, VaultEvent } from "@warden/shared";
import type { AgentProfile, Counterparty } from "../memory/schema.js";

export type PaymentEvent = Extract<VaultEvent, { kind: "spent" | "rejected" }>;

/** Everything the rules can test about one payment, computed deterministically. */
export interface PaymentContext {
  event: PaymentEvent;
  agent: string;
  counterparty: string;
  amountUsd: number;
  dailyUsd: number;
  isNewCounterparty: boolean;
  lookalikeOf?: string;
  baselineDailyUsd: number;
  daysObserved: number;
  risk?: { score: number; flags: string[] };
  /** Payments by this agent to this counterparty within the window (inclusive of this one). */
  velocity(windowMin: number): number;
  /** Rejected spends by this agent within the window. */
  rejectedCount(windowMin: number): number;
}

interface Hit {
  agent: string;
  counterparty: string;
  ts: number;
  rejected: boolean;
}

/** Sliding 24h window of recent payments for velocity checks. */
export class RecentActivity {
  private hits: Hit[] = [];
  private seen = new Set<string>();

  /** Returns false if this event was already recorded (replay after restart). */
  record(e: PaymentEvent): boolean {
    const id = `${e.digest}:${e.seq}`;
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    this.hits.push({ agent: e.label, counterparty: normalizeSuiAddress(e.recipient), ts: e.ts, rejected: e.kind === "rejected" });
    this.prune(e.ts);
    return true;
  }

  /** Counts hits in [since, until]; `until` keeps a batch's later events out of an earlier event's count. */
  count(agent: string, since: number, until: number, opts: { counterparty?: string; rejected: boolean }): number {
    let n = 0;
    for (const h of this.hits) {
      if (h.agent === agent && h.ts >= since && h.ts <= until && h.rejected === opts.rejected && (!opts.counterparty || h.counterparty === opts.counterparty)) n++;
    }
    return n;
  }

  private prune(now: number): void {
    const cutoff = now - 24 * 3_600_000;
    if (this.hits.length && this.hits[0]!.ts < cutoff) this.hits = this.hits.filter((h) => h.ts >= cutoff);
    if (this.seen.size > 50_000) this.seen = new Set([...this.seen].slice(-25_000));
  }
}

/**
 * Address-poisoning check: a lookalike shares the first and last 4 hex chars
 * of a known counterparty but is a different address.
 */
export function findLookalike(address: string, known: string[]): string | undefined {
  const a = hex(address);
  for (const k of known) {
    const b = hex(k);
    if (a !== b && a.slice(0, 4) === b.slice(0, 4) && a.slice(-4) === b.slice(-4)) return k;
  }
  return undefined;
}

const hex = (addr: string) => normalizeSuiAddress(addr).slice(2);

export function buildContext(args: {
  event: PaymentEvent;
  units: Units;
  profile?: AgentProfile;
  counterparty?: Counterparty;
  knownCounterparties: string[];
  recent: RecentActivity;
}): PaymentContext {
  const { event, units, profile, recent } = args;
  const cp = normalizeSuiAddress(event.recipient);
  const typical = new Set((profile?.typical_counterparties ?? []).map((a) => normalizeSuiAddress(a)));
  const dailyRaw = event.kind === "spent" ? event.spentToday : 0n;
  return {
    event,
    agent: event.label,
    counterparty: cp,
    amountUsd: units.toUsd(event.amount),
    dailyUsd: units.toUsd(dailyRaw),
    isNewCounterparty: !typical.has(cp),
    lookalikeOf: findLookalike(cp, args.knownCounterparties),
    baselineDailyUsd: profile?.normal_daily_spend_usd ?? 0,
    daysObserved: profile?.days_observed ?? 0,
    risk: args.counterparty?.risk_check ? { score: args.counterparty.risk_check.score, flags: args.counterparty.risk_check.flags } : undefined,
    velocity: (w) => recent.count(event.label, event.ts - w * 60_000, event.ts, { counterparty: cp, rejected: false }),
    rejectedCount: (w) => recent.count(event.label, event.ts - w * 60_000, event.ts, { rejected: true }),
  };
}

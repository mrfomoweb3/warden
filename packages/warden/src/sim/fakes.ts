import { CreditMeter, encodeVaultEvent, Units, type Chain } from "@warden/shared";

export const PKG = "0x" + "a".repeat(64);
export const VAULT = "0x" + "b".repeat(64);
export const units = new Units(9, 1); // 1 coin = $1
export const addr = (n: number) => "0x" + n.toString(16).padStart(64, "0");
export const AGENT_IDS: Record<string, string> = { researcher: addr(0x101), pricebot: addr(0x102), rogue: addr(0x103) };

interface FakeTx {
  digest: string;
  ts: number;
  events: { eventType: string; sender: string; contents: { value: Uint8Array } }[];
}

/**
 * In-memory chain that serves queued SpendVault transactions the way Tatum's gRPC
 * ListTransactions does: one frame per transaction, events BCS-encoded, then a
 * watermark and an end frame. The real decoder runs on every event.
 */
export class FakeChain {
  queue: FakeTx[] = [];
  private seq = 0;
  readonly meter = new CreditMeter();

  spend(agent: string, recipient: string, usd: number, ts: number, spentTodayUsd = usd): void {
    this.push("Spent", { vault_id: VAULT, agent: AGENT_IDS[agent], label: agent, recipient, amount: units.fromUsd(usd), memo: [], spent_today: units.fromUsd(spentTodayUsd), timestamp_ms: ts }, ts);
  }

  reject(agent: string, recipient: string, usd: number, ts: number): void {
    this.push("SpendRejected", { vault_id: VAULT, agent: AGENT_IDS[agent], label: agent, recipient, amount: units.fromUsd(usd), reason: 1, timestamp_ms: ts }, ts);
  }

  private push(name: string, fields: Record<string, unknown>, ts: number): void {
    const n = ++this.seq;
    const eventType = `${PKG}::vault::${name}`;
    this.queue.push({ digest: `tx${n}`, ts, events: [{ eventType, sender: addr(1), contents: { value: encodeVaultEvent(eventType, fields) } }] });
  }

  private listTransactions() {
    const txs = this.queue.splice(0, this.queue.length);
    const seq = this.seq;
    async function* responses() {
      for (const t of txs) {
        yield { transaction: { digest: t.digest, timestamp: { seconds: BigInt(Math.floor(t.ts / 1000)), nanos: (t.ts % 1000) * 1e6 }, events: { events: t.events } } };
      }
      yield { watermark: { cursor: Uint8Array.of(seq & 0xff, seq >> 8), checkpoint: BigInt(seq) }, end: { reason: 3 } };
    }
    return { responses: responses() };
  }

  asChain(): Chain {
    return { network: "testnet", meter: this.meter, grpc: { ledgerService: { listTransactions: this.listTransactions.bind(this) } } } as unknown as Chain;
  }
}

/** Records actuator calls instead of sending txs; tracks paused state for idempotency. */
export class FakeVault {
  calls: string[] = [];
  paused = new Set<string>();
  live = true;
  async agents() {
    return [];
  }
  async pause(id: string) {
    if (this.paused.has(id)) return { done: false, note: "already paused" };
    this.paused.add(id);
    this.calls.push(`pause:${id}`);
    return { done: true, note: `0xpause${this.calls.length}` };
  }
  async unpause(id: string) {
    if (!this.paused.delete(id)) return { done: false, note: "already active" };
    this.calls.push(`unpause:${id}`);
    return { done: true, note: `0xunpause${this.calls.length}` };
  }
  async tighten(id: string, req: { per_tx_usd?: number; daily_usd?: number }) {
    this.calls.push(`tighten:${id}:${req.per_tx_usd ?? "-"}:${req.daily_usd ?? "-"}`);
    return { done: true, note: `0xcaps${this.calls.length}` };
  }
}


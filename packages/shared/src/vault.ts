import { bcs } from "@mysten/sui/bcs";
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64, normalizeSuiAddress, toBase64 } from "@mysten/sui/utils";
import { rpc, type Chain } from "./rpc.js";

/** A SpendVault event, normalised from the gateway (or a test fake). */
export interface RawSuiEvent {
  id: { txDigest: string; eventSeq: string };
  type: string;
  sender: string;
  timestampMs?: string;
  parsedJson: Record<string, unknown>;
}

/**
 * Where the observer resumes: the gateway's opaque stream cursor (base64) plus the
 * checkpoint it covers, so the next query neither rescans nor skips anything.
 */
export type EventCursor = { checkpoint: string; after: string | null } | null;

export const REJECT_REASONS: Record<number, string> = {
  1: "paused",
  2: "over per-tx cap",
  3: "over daily cap",
  4: "vault out of funds",
};

export type VaultEvent =
  | { kind: "spent"; agentId: string; label: string; recipient: string; amount: bigint; memo: string; spentToday: bigint; ts: number; digest: string; seq: string }
  | { kind: "rejected"; agentId: string; label: string; recipient: string; amount: bigint; reason: string; ts: number; digest: string; seq: string }
  | { kind: "paused"; agentId: string; label: string; reason: string; ts: number; digest: string; seq: string }
  | { kind: "unpaused"; agentId: string; label: string; ts: number; digest: string; seq: string }
  | { kind: "caps_changed"; agentId: string; label: string; perTxCap: bigint; dailyCap: bigint; ts: number; digest: string; seq: string }
  | { kind: "agent_added"; agentId: string; label: string; spender: string; perTxCap: bigint; dailyCap: bigint; ts: number; digest: string; seq: string }
  | { kind: "other"; type: string; ts: number; digest: string; seq: string };

/** Move `vector<u8>` decodes to number[]; read it as UTF-8. */
function bytesToString(v: unknown): string {
  if (Array.isArray(v)) return new TextDecoder().decode(Uint8Array.from(v as number[]));
  return typeof v === "string" ? v : "";
}

const big = (v: unknown) => BigInt(String(v ?? 0));

export function parseVaultEvent(e: RawSuiEvent, vaultId?: string): VaultEvent | null {
  const j = e.parsedJson;
  if (vaultId && j.vault_id && normalizeSuiAddress(String(j.vault_id)) !== normalizeSuiAddress(vaultId)) return null;
  const base = { ts: Number(e.timestampMs ?? j.timestamp_ms ?? Date.now()), digest: e.id.txDigest, seq: e.id.eventSeq };
  const name = e.type.split("::").pop();
  const agentId = String(j.agent ?? "");
  const label = String(j.label ?? "");
  switch (name) {
    case "Spent":
      return { kind: "spent", agentId, label, recipient: String(j.recipient), amount: big(j.amount), memo: bytesToString(j.memo), spentToday: big(j.spent_today), ...base };
    case "SpendRejected":
      return { kind: "rejected", agentId, label, recipient: String(j.recipient), amount: big(j.amount), reason: REJECT_REASONS[Number(j.reason)] ?? `code ${j.reason}`, ...base };
    case "AgentPaused":
      return { kind: "paused", agentId, label, reason: bytesToString(j.reason), ...base };
    case "AgentUnpaused":
      return { kind: "unpaused", agentId, label, ...base };
    case "CapsChanged":
      return { kind: "caps_changed", agentId, label, perTxCap: big(j.per_tx_cap), dailyCap: big(j.daily_cap), ...base };
    case "AgentAdded":
      return { kind: "agent_added", agentId, label, spender: String(j.spender), perTxCap: big(j.per_tx_cap), dailyCap: big(j.daily_cap), ...base };
    default:
      return { kind: "other", type: e.type, ...base };
  }
}

// === BCS layouts (must match packages/vault/sources/vault.move field for field) ===

const ID = bcs.Address;
const EVENT_BCS = {
  VaultCreated: bcs.struct("VaultCreated", { vault_id: ID, owner: bcs.Address }),
  WardenSet: bcs.struct("WardenSet", { vault_id: ID, warden_cap: ID }),
  Spent: bcs.struct("Spent", { vault_id: ID, agent: ID, label: bcs.string(), recipient: bcs.Address, amount: bcs.u64(), memo: bcs.vector(bcs.u8()), spent_today: bcs.u64(), timestamp_ms: bcs.u64() }),
  SpendRejected: bcs.struct("SpendRejected", { vault_id: ID, agent: ID, label: bcs.string(), recipient: bcs.Address, amount: bcs.u64(), reason: bcs.u8(), timestamp_ms: bcs.u64() }),
  AgentPaused: bcs.struct("AgentPaused", { vault_id: ID, agent: ID, label: bcs.string(), reason: bcs.vector(bcs.u8()) }),
  AgentUnpaused: bcs.struct("AgentUnpaused", { vault_id: ID, agent: ID, label: bcs.string() }),
  CapsChanged: bcs.struct("CapsChanged", { vault_id: ID, agent: ID, label: bcs.string(), per_tx_cap: bcs.u64(), daily_cap: bcs.u64() }),
  AgentAdded: bcs.struct("AgentAdded", { vault_id: ID, agent: ID, label: bcs.string(), spender: bcs.Address, per_tx_cap: bcs.u64(), daily_cap: bcs.u64() }),
} as const;

const AgentStateBcs = bcs.struct("AgentState", {
  label: bcs.string(),
  per_tx_cap: bcs.u64(),
  daily_cap: bcs.u64(),
  max_per_tx: bcs.u64(),
  max_daily: bcs.u64(),
  spent_today: bcs.u64(),
  day: bcs.u64(),
  paused: bcs.bool(),
});

/** Decodes a SpendVault event's BCS contents; unknown event kinds come back empty. */
export function decodeVaultEvent(type: string, contents: Uint8Array): Record<string, unknown> {
  const layout = EVENT_BCS[type.split("::").pop() as keyof typeof EVENT_BCS];
  return layout ? (layout.parse(contents) as Record<string, unknown>) : {};
}

/** Inverse of decodeVaultEvent, for simulations and tests. */
export function encodeVaultEvent(type: string, fields: Record<string, unknown>): Uint8Array {
  const layout = EVENT_BCS[type.split("::").pop() as keyof typeof EVENT_BCS];
  if (!layout) throw new Error(`no BCS layout for ${type}`);
  return (layout as { serialize(v: unknown): { toBytes(): Uint8Array } }).serialize(fields).toBytes();
}

const affectedObject = (objectId: string) => ({
  terms: [{ literals: [{ negated: false, predicate: { oneofKind: "affectedObject" as const, affectedObject: { objectId } } }] }],
});

/**
 * One page of SpendVault events (all agents) in ascending order.
 *
 * Tatum's gateway doesn't allow ListEvents, so this lists the transactions that
 * touched the vault object instead. Every vault function takes `&mut Vault`, so
 * every spend, rejection, pause and cap change bumps the vault and shows up here.
 */
export async function queryVaultEvents(
  chain: Chain,
  packageId: string,
  vaultId: string,
  cursor: EventCursor,
  limit = 50,
): Promise<{ data: RawSuiEvent[]; nextCursor: EventCursor; hasNextPage: boolean }> {
  const prefix = `${normalizeSuiAddress(packageId)}::vault::`;
  return rpc(chain, "ListTransactions", async () => {
    const data: RawSuiEvent[] = [];
    let next = cursor;
    let hasNextPage = false;
    const call = chain.grpc.ledgerService.listTransactions({
      startCheckpoint: cursor ? BigInt(cursor.checkpoint) : undefined,
      filter: affectedObject(normalizeSuiAddress(vaultId)),
      options: { limit, after: cursor?.after ? fromBase64(cursor.after) : undefined },
      readMask: { paths: ["digest", "timestamp", "events"] },
    });
    for await (const frame of call.responses) {
      const tx = frame.transaction;
      if (tx?.digest) {
        const ts = tx.timestamp ? Number(tx.timestamp.seconds) * 1000 + Math.floor(tx.timestamp.nanos / 1e6) : undefined;
        (tx.events?.events ?? []).forEach((e, i) => {
          const type = normalizeType(e.eventType ?? "");
          if (!type.startsWith(prefix) || !e.contents?.value) return;
          data.push({
            id: { txDigest: tx.digest!, eventSeq: String(i) },
            type,
            sender: e.sender ?? "",
            timestampMs: ts === undefined ? undefined : String(ts),
            parsedJson: decodeVaultEvent(type, e.contents.value),
          });
        });
      }
      if (frame.watermark?.cursor?.length) {
        next = { checkpoint: String(frame.watermark.checkpoint ?? cursor?.checkpoint ?? 0), after: toBase64(frame.watermark.cursor) };
      }
      // ITEM_LIMIT (1) and SCAN_LIMIT (2) mean there is more to read; CHECKPOINT_BOUND means we reached the tip.
      if (frame.end) {
        hasNextPage = frame.end.reason === 1 || frame.end.reason === 2;
        break;
      }
    }
    return { data, nextCursor: next, hasNextPage };
  });
}

/** `0x2::coin::X` and `0x000…2::coin::X` must compare equal. */
function normalizeType(type: string): string {
  const i = type.indexOf("::");
  return i < 0 ? type : normalizeSuiAddress(type.slice(0, i)) + type.slice(i);
}

/** Coin amounts ↔ USD for rules written in dollars. */
export class Units {
  constructor(
    readonly decimals: number,
    readonly usdPerCoin: number,
  ) {}
  toUsd(raw: bigint): number {
    return (Number(raw) / 10 ** this.decimals) * this.usdPerCoin;
  }
  fromUsd(usd: number): bigint {
    return BigInt(Math.round((usd / this.usdPerCoin) * 10 ** this.decimals));
  }
}

// === Transaction builders ===

export interface VaultRef {
  packageId: string;
  vaultId: string;
  coinType: string;
}

export function buildSpend(v: VaultRef, spenderCapId: string, amount: bigint, recipient: string, memo: string): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${v.packageId}::vault::spend`,
    typeArguments: [v.coinType],
    arguments: [
      tx.object(spenderCapId),
      tx.object(v.vaultId),
      tx.pure.u64(amount),
      tx.pure.address(recipient),
      tx.pure.vector("u8", Array.from(new TextEncoder().encode(memo))),
      tx.object.clock(),
    ],
  });
  return tx;
}

export function buildPause(v: VaultRef, wardenCapId: string, agentId: string, reason: string): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${v.packageId}::vault::pause_agent`,
    typeArguments: [v.coinType],
    arguments: [
      tx.object(wardenCapId),
      tx.object(v.vaultId),
      tx.pure.id(agentId),
      tx.pure.vector("u8", Array.from(new TextEncoder().encode(reason.slice(0, 200)))),
    ],
  });
  return tx;
}

export function buildUnpause(v: VaultRef, wardenCapId: string, agentId: string): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${v.packageId}::vault::unpause_agent`,
    typeArguments: [v.coinType],
    arguments: [tx.object(wardenCapId), tx.object(v.vaultId), tx.pure.id(agentId)],
  });
  return tx;
}

export function buildSetCaps(v: VaultRef, wardenCapId: string, agentId: string, perTx: bigint, daily: bigint): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${v.packageId}::vault::set_caps`,
    typeArguments: [v.coinType],
    arguments: [tx.object(wardenCapId), tx.object(v.vaultId), tx.pure.id(agentId), tx.pure.u64(perTx), tx.pure.u64(daily)],
  });
  return tx;
}

export interface AgentOnChain {
  agentId: string;
  label: string;
  paused: boolean;
  perTxCap: bigint;
  dailyCap: bigint;
  maxPerTx: bigint;
  maxDaily: bigint;
  spentToday: bigint;
}

/** Reads every agent's live state from the vault's Table (dynamic fields, decoded from BCS). */
export async function readAgents(chain: Chain, vaultId: string): Promise<AgentOnChain[]> {
  const vault = await rpc(chain, "GetObject", () => chain.grpc.getObject({ objectId: vaultId, include: { json: true } }));
  const agents = (vault.object.json as { agents?: { id?: unknown } } | null)?.agents;
  // The Table's UID renders as a plain id string over gRPC (older APIs nested it as { id }).
  const tableId = typeof agents?.id === "string" ? agents.id : (agents?.id as { id?: string } | undefined)?.id;
  if (!tableId) return [];
  const out: AgentOnChain[] = [];
  let cursor: string | null = null;
  do {
    const page = await rpc(chain, "ListDynamicFields", () => chain.grpc.listDynamicFields({ parentId: tableId, cursor, limit: 50, include: { value: true } }));
    for (const f of page.dynamicFields) {
      const s = AgentStateBcs.parse(f.value.bcs);
      out.push({
        agentId: bcs.Address.parse(f.name.bcs),
        label: s.label,
        paused: s.paused,
        perTxCap: BigInt(s.per_tx_cap),
        dailyCap: BigInt(s.daily_cap),
        maxPerTx: BigInt(s.max_per_tx),
        maxDaily: BigInt(s.max_daily),
        // spent_today only counts for the vault's current day; a stale day means nothing spent yet today.
        spentToday: BigInt(s.day) === BigInt(Math.floor(Date.now() / 86_400_000)) ? BigInt(s.spent_today) : 0n,
      });
    }
    cursor = page.hasNextPage ? page.cursor : null;
  } while (cursor);
  return out;
}

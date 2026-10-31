import {
  buildPause,
  buildSetCaps,
  buildUnpause,
  execute,
  readAgents,
  type AgentOnChain,
  type Chain,
  type Units,
  type VaultRef,
} from "@warden/shared";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

export interface ActResult {
  done: boolean;
  /** Tx digest, or why nothing was sent (already in that state, dry run). */
  note: string;
}

/**
 * Warden's hands on SpendVault. Every call reads live state first and skips the
 * tx when the agent is already in the target state, so running twice is safe
 * (the Move side is idempotent too).
 */
export class VaultActuator {
  constructor(
    private readonly chain: Chain,
    private readonly vault: VaultRef,
    private readonly units: Units,
    private readonly signer: Ed25519Keypair | null,
    private readonly wardenCapId: string | null,
  ) {}

  get live(): boolean {
    return Boolean(this.signer && this.wardenCapId);
  }

  agents(): Promise<AgentOnChain[]> {
    return readAgents(this.chain, this.vault.vaultId);
  }

  private async state(agentId: string): Promise<AgentOnChain | undefined> {
    return (await this.agents()).find((a) => a.agentId === agentId);
  }

  async pause(agentId: string, reason: string): Promise<ActResult> {
    const s = await this.state(agentId);
    if (s?.paused) return { done: false, note: "already paused" };
    if (!this.live) return { done: false, note: "dry run (no WARDEN_PRIVATE_KEY / WARDEN_CAP_ID)" };
    const r = await execute(this.chain, this.signer!, buildPause(this.vault, this.wardenCapId!, agentId, reason));
    return { done: true, note: r.digest };
  }

  async unpause(agentId: string): Promise<ActResult> {
    const s = await this.state(agentId);
    if (s && !s.paused) return { done: false, note: "already active" };
    if (!this.live) return { done: false, note: "dry run (no WARDEN_PRIVATE_KEY / WARDEN_CAP_ID)" };
    const r = await execute(this.chain, this.signer!, buildUnpause(this.vault, this.wardenCapId!, agentId));
    return { done: true, note: r.digest };
  }

  /** Lowers caps toward the requested USD values, clamped to the owner's ceilings. */
  async tighten(agentId: string, req: { per_tx_usd?: number; daily_usd?: number }): Promise<ActResult> {
    const s = await this.state(agentId);
    if (!s) return { done: false, note: "agent not found in vault" };
    const clamp = (want: number | undefined, cur: bigint, max: bigint) =>
      want === undefined ? cur : bigMin(this.units.fromUsd(want), max);
    const perTx = clamp(req.per_tx_usd, s.perTxCap, s.maxPerTx);
    const daily = clamp(req.daily_usd, s.dailyCap, s.maxDaily);
    if (perTx === s.perTxCap && daily === s.dailyCap) return { done: false, note: "caps already set" };
    if (!this.live) return { done: false, note: "dry run (no WARDEN_PRIVATE_KEY / WARDEN_CAP_ID)" };
    const r = await execute(this.chain, this.signer!, buildSetCaps(this.vault, this.wardenCapId!, agentId, perTx, daily));
    return { done: true, note: r.digest };
  }
}

const bigMin = (a: bigint, b: bigint) => (a < b ? a : b);

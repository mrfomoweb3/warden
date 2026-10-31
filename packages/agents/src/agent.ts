import { normalizeStructTag } from "@mysten/sui/utils";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { buildSpend, execute, fetchWithPayment, type Chain, type VaultRef } from "@warden/shared";

/**
 * A watched agent. It can only pay through SpendVault, so every payment is
 * visible to Warden and stoppable by it.
 */
export class DemoAgent {
  paid = 0;
  blocked = 0;

  constructor(
    readonly name: string,
    private readonly chain: Chain,
    private readonly keypair: Ed25519Keypair,
    private readonly spenderCapId: string,
    private readonly vault: VaultRef,
    private readonly log: (m: string) => void = (m) => console.log(`[${name}] ${m}`),
  ) {}

  /** Calls a paid endpoint; on 402 pays from the vault (memo = challenge nonce) and retries. */
  async call(url: string): Promise<unknown | null> {
    let rejected = false;
    const { res, paid } = await fetchWithPayment(url, { method: "GET" }, async (req) => {
      if (normalizeStructTag(req.asset) !== normalizeStructTag(this.vault.coinType)) {
        this.log(`refusing: ${url} wants ${req.asset}, vault holds ${this.vault.coinType}`);
        return null;
      }
      const tx = buildSpend(this.vault, this.spenderCapId, BigInt(req.maxAmountRequired), req.payTo, req.extra.nonce);
      const r = await execute(this.chain, this.keypair, tx);
      if (r.events.some((e) => e.type.endsWith("::vault::SpendRejected"))) {
        rejected = true;
        return null;
      }
      return r.digest;
    });
    if (rejected) {
      this.blocked++;
      this.log(`vault blocked payment for ${url}`);
      return null;
    }
    if (!res.ok) {
      this.log(`${url} → HTTP ${res.status}`);
      return null;
    }
    this.paid++;
    if (paid) this.log(`paid ${url} (tx ${paid.transaction.slice(0, 10)}…)`);
    return res.json();
  }
}

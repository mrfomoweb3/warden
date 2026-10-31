import { coinWithBalance, Transaction } from "@mysten/sui/transactions";
import type { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { execute, fetchWithPayment, type Chain } from "@warden/shared";

export interface RiskResult {
  score: number;
  flags: string[];
  /** Sui tx that paid for the check. */
  paidTx?: string;
}

export interface RiskChecker {
  check(address: string): Promise<RiskResult | null>;
}

/**
 * Buys a counterparty risk check over x402: the API answers 402, Warden pays from
 * its own small wallet with a plain transfer on Sui, then retries with the digest.
 */
export class X402RiskChecker implements RiskChecker {
  constructor(
    private readonly chain: Chain,
    private readonly payer: Ed25519Keypair,
    private readonly baseUrl: string,
    /** Refuse to pay more than this per check (raw units). */
    private readonly maxPrice: bigint,
  ) {}

  async check(address: string): Promise<RiskResult | null> {
    const { res, digest } = await fetchWithPayment(`${this.baseUrl}/risk/${address}`, { method: "GET" }, async (req) => {
      const price = BigInt(req.maxAmountRequired);
      if (price > this.maxPrice) return null;
      const tx = new Transaction();
      tx.transferObjects([coinWithBalance({ type: req.asset, balance: price })], req.payTo);
      return (await execute(this.chain, this.payer, tx)).digest;
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { score: number; flags: string[] };
    return { score: body.score, flags: body.flags, paidTx: digest };
  }
}

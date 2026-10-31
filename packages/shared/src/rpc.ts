import type { SuiGrpcClient } from "@mysten/sui/grpc";
import { createGrpcClient } from "./grpc.js";

export type SuiNetwork = "mainnet" | "testnet" | "devnet" | "localnet";

/**
 * Per-method credit cost on the Tatum gateway. VERIFY against Tatum's pricing page;
 * these are used for the daily budget log only and never block a call.
 */
const CREDIT_COST: Record<string, number> = { default: 1 };

export class CreditMeter {
  private day = utcDay();
  private used = 0;
  private byMethod = new Map<string, number>();

  record(method: string): void {
    const today = utcDay();
    if (today !== this.day) {
      this.day = today;
      this.used = 0;
      this.byMethod.clear();
    }
    const cost = CREDIT_COST[method] ?? CREDIT_COST.default!;
    this.used += cost;
    this.byMethod.set(method, (this.byMethod.get(method) ?? 0) + 1);
  }

  snapshot(): { day: string; credits: number; calls: Record<string, number> } {
    return { day: this.day, credits: this.used, calls: Object.fromEntries(this.byMethod) };
  }
}

export class RpcError extends Error {
  constructor(
    readonly method: string,
    message: string,
  ) {
    super(`${method}: ${message}`);
  }
}

/** Spaces calls evenly so one process stays under the gateway's requests-per-second limit. */
export class RateLimiter {
  private nextAt = 0;
  constructor(private readonly minGapMs: number) {}

  async take(): Promise<void> {
    const now = Date.now();
    const wait = Math.max(0, this.nextAt - now);
    this.nextAt = Math.max(now, this.nextAt) + this.minGapMs;
    if (wait) await sleep(wait);
  }
}

/** One chain handle for reads and writes, all routed through Tatum's Sui gRPC gateway. */
export interface Chain {
  network: SuiNetwork;
  meter: CreditMeter;
  grpc: SuiGrpcClient;
  /** Optional so test fakes can omit it. */
  limiter?: RateLimiter;
}

/** TATUM_MAX_RPS caps this process's call rate (Tatum's free plan rate-limits bursts with HTTP 429). */
export async function createChain(opts: { url: string; apiKey?: string; network: SuiNetwork; maxRps?: number }): Promise<Chain> {
  const rps = opts.maxRps ?? Number(process.env.TATUM_MAX_RPS ?? 3);
  return { network: opts.network, meter: new CreditMeter(), grpc: await createGrpcClient(opts), limiter: new RateLimiter(1000 / rps) };
}

/** Rate limits (429 / RESOURCE_EXHAUSTED), dropped connections and transient upstream failures are worth a retry. */
export const RETRYABLE = /RESOURCE_EXHAUSTED|UNAVAILABLE|DEADLINE_EXCEEDED|ECONNRESET|ETIMEDOUT|socket hang up|\b429\b|\b50[234]\b/i;
/** The gateway refused the request outright, so it never reached a node: always safe to resend. */
export const GATEWAY_REJECTED = /RESOURCE_EXHAUSTED|\b429\b/i;

/** Runs one metered, rate-limited gateway call, retrying with backoff on `retryOn` failures. */
export async function rpc<T>(chain: Chain, method: string, fn: () => Promise<T>, maxRetries = 4, retryOn = RETRYABLE): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    await chain.limiter?.take();
    chain.meter.record(method);
    try {
      return await fn();
    } catch (e) {
      const err = e as Error & { code?: string };
      if (attempt < maxRetries && retryOn.test(`${err.code ?? ""} ${err.message}`)) {
        await sleep(1000 * 2 ** attempt);
        continue;
      }
      throw new RpcError(method, err.message);
    }
  }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function utcDay(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

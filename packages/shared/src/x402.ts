/**
 * x402 on Sui, self-hosted, settle-first.
 *
 * Wire: HTTP 402 with an `accepts[]` body (x402 v1 shape), client retries with
 * `X-PAYMENT` (base64 JSON), server answers with `X-PAYMENT-RESPONSE`.
 *
 * Settlement differs from the facilitator flow: the client settles on Sui first
 * (a SpendVault `spend`, or a plain transfer for Warden's own wallet) and sends
 * the tx digest. The server verifies on-chain that the tx succeeded, paid `payTo`
 * at least `maxAmountRequired` of `asset`, happened after the challenge was issued,
 * and that the digest has not been redeemed before. When the payment came from
 * SpendVault, the `Spent.memo` must equal the challenge nonce.
 */
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";
import { rpc, type Chain, type SuiNetwork } from "./rpc.js";
import { decodeVaultEvent } from "./vault.js";

export const X402_VERSION = 1;
export const PAYMENT_HEADER = "x-payment";
export const PAYMENT_RESPONSE_HEADER = "x-payment-response";

export interface PaymentRequirements {
  scheme: "exact";
  network: `sui-${SuiNetwork}`;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra: { settlement: "sui-tx"; nonce: string; issuedAtMs: number };
}

export interface PaymentRequired {
  x402Version: number;
  error: string;
  accepts: PaymentRequirements[];
}

export interface PaymentPayload {
  x402Version: number;
  scheme: "exact";
  network: string;
  payload: { digest: string; nonce: string };
}

export interface PaymentResponse {
  success: boolean;
  transaction: string;
  network: string;
  payer: string;
  errorReason?: string;
}

export const encodeHeader = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");
export const decodeHeader = <T>(h: string): T => JSON.parse(Buffer.from(h, "base64").toString("utf8")) as T;

export type VerifyResult = { ok: true; payer: string; amount: bigint } | { ok: false; reason: string };

interface TxBlock {
  digest: string;
  timestampMs?: string;
  transaction?: { data?: { sender?: string } };
  effects?: { status?: { status: string; error?: string } };
  balanceChanges?: { owner: { AddressOwner?: string } | unknown; coinType: string; amount: string }[];
  events?: { type: string; parsedJson: Record<string, unknown> }[];
}

/** Pure check of a fetched tx against requirements. Exported for tests. */
export function checkPayment(tx: TxBlock, req: PaymentRequirements, nonce: string): VerifyResult {
  if (tx.effects?.status?.status !== "success") return { ok: false, reason: `tx failed: ${tx.effects?.status?.error ?? "unknown"}` };
  const ts = Number(tx.timestampMs ?? 0);
  if (ts && ts + 5_000 < req.extra.issuedAtMs) return { ok: false, reason: "tx predates the payment challenge" };
  if (ts && ts > req.extra.issuedAtMs + req.maxTimeoutSeconds * 1000) return { ok: false, reason: "payment arrived after challenge expired" };

  const payTo = normalizeSuiAddress(req.payTo);
  const asset = normalizeStructTag(req.asset);
  const received = (tx.balanceChanges ?? [])
    .filter((b) => {
      const owner = (b.owner as { AddressOwner?: string }).AddressOwner;
      return owner && normalizeSuiAddress(owner) === payTo && normalizeStructTag(b.coinType) === asset;
    })
    .reduce((sum, b) => sum + BigInt(b.amount), 0n);
  if (received < BigInt(req.maxAmountRequired)) {
    return { ok: false, reason: `paid ${received} < required ${req.maxAmountRequired}` };
  }

  const spent = (tx.events ?? []).find((e) => e.type.endsWith("::vault::Spent"));
  if (spent) {
    const memo = spent.parsedJson.memo;
    const memoStr = Array.isArray(memo) ? new TextDecoder().decode(Uint8Array.from(memo as number[])) : String(memo ?? "");
    if (memoStr !== nonce) return { ok: false, reason: "vault payment memo does not match nonce" };
  }
  return { ok: true, payer: tx.transaction?.data?.sender ?? "unknown", amount: received };
}

/** Fetches a payment tx over gRPC and maps it onto the shape `checkPayment` reads. */
export async function fetchTx(chain: Chain, digest: string): Promise<TxBlock> {
  const res = await rpc(chain, "GetTransaction", () =>
    chain.grpc.getTransaction({ digest, include: { effects: true, events: true, balanceChanges: true, transaction: true } }));
  const t = res.Transaction ?? res.FailedTransaction;
  return {
    digest: t.digest,
    timestampMs: t.timestampMs === null ? undefined : String(t.timestampMs),
    transaction: { data: { sender: t.transaction?.sender ?? undefined } },
    effects: { status: t.status.success ? { status: "success" } : { status: "failure", error: t.status.error.message } },
    balanceChanges: (t.balanceChanges ?? []).map((b) => ({ owner: { AddressOwner: b.address }, coinType: b.coinType, amount: b.amount })),
    events: (t.events ?? []).map((e) => ({
      type: e.eventType,
      parsedJson: e.eventType.includes("::vault::") ? decodeVaultEvent(e.eventType, e.bcs) : (e.json ?? {}),
    })),
  };
}

/** Server side: issues challenges and redeems each digest at most once. */
export class X402Gate {
  private challenges = new Map<string, PaymentRequirements>();
  private redeemed = new Set<string>();

  constructor(
    private readonly chain: Chain,
    private readonly payTo: string,
    private readonly asset: string,
  ) {}

  challenge(resource: string, price: bigint, description: string): PaymentRequired {
    const now = Date.now();
    for (const [n, r] of this.challenges) {
      if (now - r.extra.issuedAtMs > 2 * r.maxTimeoutSeconds * 1000) this.challenges.delete(n);
    }
    const nonce = crypto.randomUUID();
    const req: PaymentRequirements = {
      scheme: "exact",
      network: `sui-${this.chain.network}`,
      maxAmountRequired: price.toString(),
      resource,
      description,
      mimeType: "application/json",
      payTo: this.payTo,
      maxTimeoutSeconds: 120,
      asset: this.asset,
      extra: { settlement: "sui-tx", nonce, issuedAtMs: Date.now() },
    };
    this.challenges.set(nonce, req);
    return { x402Version: X402_VERSION, error: "payment required", accepts: [req] };
  }

  async redeem(header: string, resource: string): Promise<PaymentResponse> {
    const fail = (errorReason: string, digest = ""): PaymentResponse => ({
      success: false,
      transaction: digest,
      network: `sui-${this.chain.network}`,
      payer: "",
      errorReason,
    });
    let p: PaymentPayload;
    try {
      p = decodeHeader<PaymentPayload>(header);
    } catch {
      return fail("malformed X-PAYMENT header");
    }
    const { digest, nonce } = p.payload ?? {};
    const req = nonce ? this.challenges.get(nonce) : undefined;
    if (!req || req.resource !== resource) return fail("unknown or mismatched challenge", digest);
    if (this.redeemed.has(digest)) return fail("payment already redeemed", digest);
    // Reserve before the async check so two concurrent retries can't both pass.
    this.redeemed.add(digest);
    try {
      const result = checkPayment(await fetchTx(this.chain, digest), req, nonce);
      if (!result.ok) {
        this.redeemed.delete(digest);
        return fail(result.reason, digest);
      }
      this.challenges.delete(nonce);
      return { success: true, transaction: digest, network: req.network, payer: result.payer };
    } catch (e) {
      this.redeemed.delete(digest);
      return fail(`verification error: ${(e as Error).message}`, digest);
    }
  }
}

/**
 * Client side: fetch that pays on 402. `settle` performs the on-chain payment
 * (vault spend or transfer) and returns the tx digest, or null to refuse.
 */
export async function fetchWithPayment(
  url: string,
  init: RequestInit,
  settle: (req: PaymentRequirements) => Promise<string | null>,
): Promise<{ res: Response; paid?: PaymentResponse; digest?: string }> {
  const first = await fetch(url, init);
  if (first.status !== 402) return { res: first };
  const body = (await first.json()) as PaymentRequired;
  const req = body.accepts.find((a) => a.scheme === "exact" && a.network.startsWith("sui-"));
  if (!req) throw new Error(`no Sui payment option at ${url}`);
  const digest = await settle(req);
  if (!digest) return { res: first };
  const payload: PaymentPayload = {
    x402Version: X402_VERSION,
    scheme: "exact",
    network: req.network,
    payload: { digest, nonce: req.extra.nonce },
  };
  const headers = new Headers(init.headers);
  headers.set(PAYMENT_HEADER, encodeHeader(payload));
  const res = await fetch(url, { ...init, headers });
  const pr = res.headers.get(PAYMENT_RESPONSE_HEADER);
  return { res, digest, paid: pr ? decodeHeader<PaymentResponse>(pr) : undefined };
}

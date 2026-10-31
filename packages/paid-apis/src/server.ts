/**
 * Demo x402 services settled on Sui. Each vendor has its own pay-to address, so
 * agents paying different vendors look like different counterparties on-chain.
 *
 *   GET /search?q=…&vendor=…   paid search (researcher)
 *   GET /price/:symbol         paid price feed (pricebot, rogue)
 *   GET /risk/:address         paid counterparty risk check (Warden itself)
 *   GET /vendors               free: vendor list
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isValidSuiAddress, normalizeSuiAddress } from "@mysten/sui/utils";
import { createChain, encodeHeader, PAYMENT_HEADER, PAYMENT_RESPONSE_HEADER, requireEnv, rpc, Units, X402Gate, type Chain, type SuiNetwork } from "@warden/shared";

const network = (process.env.SUI_NETWORK ?? "testnet") as SuiNetwork;
const chain = await createChain({ url: requireEnv("TATUM_SUI_RPC_URL"), apiKey: process.env.TATUM_API_KEY, network });
const coinType = process.env.VAULT_COIN_TYPE ?? "0x2::sui::SUI";
const units = new Units(Number(process.env.VAULT_COIN_DECIMALS ?? 9), Number(process.env.VAULT_COIN_USD ?? 1));
const defaultPayTo = requireEnv("PAID_API_PAYTO");

/** PAID_API_VENDORS="search-a:0x…,search-b:0x…,news:0x…"; any vendor without an address uses PAID_API_PAYTO. */
const vendors = new Map<string, string>(
  (process.env.PAID_API_VENDORS ?? "search:,price:,risk:")
    .split(",")
    .filter(Boolean)
    .map((v) => {
      const [name, addr] = v.split(":");
      return [name!.trim(), addr?.trim() || defaultPayTo] as [string, string];
    }),
);
for (const v of ["search", "price", "risk"]) if (!vendors.has(v)) vendors.set(v, defaultPayTo);

const gates = new Map<string, X402Gate>();
const gateFor = (vendor: string) => {
  let g = gates.get(vendor);
  if (!g) gates.set(vendor, (g = new X402Gate(chain, vendors.get(vendor) ?? defaultPayTo, coinType)));
  return g;
};

const PRICES_USD = { search: 0.002, price: 0.001, risk: 0.01 };

async function paywall(req: IncomingMessage, res: ServerResponse, vendor: string, usd: number, description: string): Promise<boolean> {
  const gate = gateFor(vendor);
  const resource = `${vendor}:${new URL(req.url!, "http://x").pathname}`;
  const header = req.headers[PAYMENT_HEADER];
  if (typeof header !== "string") {
    json(res, 402, gate.challenge(resource, units.fromUsd(usd), description));
    return false;
  }
  const result = await gate.redeem(header, resource);
  if (!result.success) {
    json(res, 402, { ...gate.challenge(resource, units.fromUsd(usd), description), error: result.errorReason });
    return false;
  }
  res.setHeader(PAYMENT_RESPONSE_HEADER, encodeHeader(result));
  return true;
}

async function riskOf(chainRef: Chain, address: string): Promise<{ score: number; flags: string[]; facts: Record<string, unknown> }> {
  const flags: string[] = [];
  const owner = normalizeSuiAddress(address);
  const [balances, sent] = await Promise.all([
    rpc(chainRef, "ListBalances", async () => (await chainRef.grpc.listBalances({ owner, limit: 50 })).balances),
    rpc(chainRef, "ListTransactions", () => countSent(chainRef, owner, 50)),
  ]);
  const sui = BigInt(balances.find((b) => b.coinType.endsWith("::sui::SUI"))?.balance ?? "0");
  let score = 0.2;
  if (sent === 0) {
    flags.push("never sent a transaction in the retention window");
    score += 0.3;
  }
  if (sui === 0n) {
    flags.push("holds no SUI (cannot pay gas)");
    score += 0.2;
  }
  if (balances.length > 20) {
    flags.push("holds many coin types (possible dust/airdrop spam)");
    score += 0.2;
  }
  return { score: Math.min(1, Math.round(score * 100) / 100), flags, facts: { sui_balance: sui.toString(), coin_types: balances.length, recent_sent_txs: sent } };
}

/** Counts up to `limit` transactions sent by `owner` (gRPC ListTransactions, sender filter). */
async function countSent(chainRef: Chain, owner: string, limit: number): Promise<number> {
  let n = 0;
  const call = chainRef.grpc.ledgerService.listTransactions({
    filter: { terms: [{ literals: [{ negated: false, predicate: { oneofKind: "sender", sender: { address: owner } } }] }] },
    options: { limit },
    readMask: { paths: ["digest"] },
  });
  for await (const frame of call.responses) {
    if (frame.transaction) n++;
    if (frame.end) break;
  }
  return n;
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url!, "http://localhost");
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.pathname === "/vendors") return json(res, 200, Object.fromEntries(vendors));
    if (parts[0] === "search") {
      const vendor = url.searchParams.get("vendor") ?? "search";
      if (!vendors.has(vendor)) return json(res, 404, { error: `unknown vendor ${vendor}` });
      if (!(await paywall(req, res, vendor, PRICES_USD.search, "web search, 5 results"))) return;
      const q = url.searchParams.get("q") ?? "";
      return json(res, 200, { vendor, q, results: Array.from({ length: 5 }, (_, i) => ({ title: `${q} — result ${i + 1}`, url: `https://example.com/${encodeURIComponent(q)}/${i + 1}` })) });
    }
    if (parts[0] === "price" && parts[1]) {
      if (!(await paywall(req, res, "price", PRICES_USD.price, `spot price for ${parts[1]}`))) return;
      const base = { SUI: 3.4, BTC: 68000, ETH: 3500, WAL: 0.6 }[parts[1].toUpperCase()] ?? 1;
      return json(res, 200, { symbol: parts[1].toUpperCase(), usd: Math.round(base * (1 + (Math.random() - 0.5) * 0.01) * 1e4) / 1e4, ts: Date.now() });
    }
    if (parts[0] === "risk" && parts[1]) {
      if (!isValidSuiAddress(normalizeSuiAddress(parts[1]))) return json(res, 400, { error: "invalid address" });
      if (!(await paywall(req, res, "risk", PRICES_USD.risk, "counterparty risk check"))) return;
      return json(res, 200, { address: parts[1], ...(await riskOf(chain, normalizeSuiAddress(parts[1]))) });
    }
    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 500, { error: (e as Error).message });
  }
});

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const port = Number(process.env.PAID_API_PORT ?? 4021);
server.listen(port, () => {
  console.log(`[paid-apis] x402 on Sui ${network}, listening on :${port}`);
  for (const [v, a] of vendors) console.log(`  ${v.padEnd(10)} → ${a}`);
});

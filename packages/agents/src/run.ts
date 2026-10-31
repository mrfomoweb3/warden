/**
 * Runs the demo agents.
 *
 *   pnpm agents                 # researcher + pricebot + rogue (behaving)
 *   pnpm agents rogue --go-rogue  # rogue loops on one API — the anomaly Warden catches live
 */
import { createChain, keypairFrom, requireEnv, sleep, type SuiNetwork } from "@warden/shared";
import { DemoAgent } from "./agent.js";

const chain = await createChain({
  url: requireEnv("TATUM_SUI_RPC_URL"),
  apiKey: process.env.TATUM_API_KEY,
  network: (process.env.SUI_NETWORK ?? "testnet") as SuiNetwork,
});
const vault = { packageId: requireEnv("VAULT_PACKAGE_ID"), vaultId: requireEnv("VAULT_OBJECT_ID"), coinType: process.env.VAULT_COIN_TYPE ?? "0x2::sui::SUI" };
const api = process.env.PAID_API_URL ?? "http://localhost:4021";

function agent(name: string): DemoAgent {
  const up = name.toUpperCase();
  return new DemoAgent(name, chain, keypairFrom(requireEnv(`${up}_PRIVATE_KEY`)), requireEnv(`${up}_CAP_ID`), vault);
}

const jitter = (minMs: number, maxMs: number) => minMs + Math.random() * (maxMs - minMs);
const TOPICS = ["sui move security", "x402 adoption", "walrus storage pricing", "agent payments", "stablecoin flows on sui"];

async function loop(fn: () => Promise<unknown>, wait: () => number): Promise<never> {
  for (;;) {
    try {
      await fn();
    } catch (e) {
      console.error((e as Error).message);
    }
    await sleep(wait());
  }
}

async function main(): Promise<void> {
  const [which = "all", ...flags] = process.argv.slice(2);
  const goRogue = flags.includes("--go-rogue");
  const vendors = Object.keys((await (await fetch(`${api}/vendors`)).json()) as Record<string, string>).filter((v) => v.startsWith("search"));
  const runs: Promise<never>[] = [];

  if (which === "all" || which === "researcher") {
    const a = agent("researcher");
    // A few searches an hour, sometimes from a vendor it hasn't used yet.
    runs.push(loop(() => a.call(`${api}/search?vendor=${vendors[Math.floor(Math.random() * vendors.length)]}&q=${encodeURIComponent(TOPICS[Math.floor(Math.random() * TOPICS.length)]!)}`), () => jitter(8 * 60_000, 20 * 60_000)));
  }
  if (which === "all" || which === "pricebot") {
    const a = agent("pricebot");
    runs.push(loop(() => a.call(`${api}/price/SUI`), () => 5 * 60_000));
  }
  if (which === "all" || which === "rogue") {
    const a = agent("rogue");
    if (goRogue) {
      console.log("[rogue] going rogue: hammering one endpoint every 2s");
      runs.push(loop(() => a.call(`${api}/search?vendor=${vendors[0]}&q=retry`), () => 2_000));
    } else {
      runs.push(loop(() => a.call(`${api}/price/BTC`), () => jitter(10 * 60_000, 15 * 60_000)));
    }
  }
  if (!runs.length) throw new Error(`unknown agent ${which}`);
  await Promise.all(runs);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

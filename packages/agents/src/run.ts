/**
 * Runs the demo agents.
 *
 *   pnpm agents                 # researcher (an LLM agent when GROQ_API_KEY is set) + pricebot + rogue (behaving)
 *   pnpm agents rogue --go-rogue  # rogue loops on one API — the anomaly Warden catches live
 */
import { createChain, keypairFrom, requireEnv, sleep, type SuiNetwork } from "@warden/shared";
import { DemoAgent } from "./agent.js";
import { LlmResearcher } from "./researcher.js";

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
const QUESTIONS = [
  "Is SUI trending up or down today, and what's driving it?",
  "How widely is x402 used for agent payments so far?",
  "What does storing a gigabyte on Walrus cost compared to other options?",
  "What are the most common security issues in Sui Move contracts?",
  "How are stablecoin flows on Sui changing this month?",
];
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
    const scripted = () => a.call(`${api}/search?vendor=${vendors[Math.floor(Math.random() * vendors.length)]}&q=${encodeURIComponent(TOPICS[Math.floor(Math.random() * TOPICS.length)]!)}`);
    // With an LLM key, a model decides which paid APIs to call for each question; otherwise a scripted search.
    const llm = process.env.GROQ_API_KEY
      ? new LlmResearcher(a, api, vendors, { apiKey: process.env.GROQ_API_KEY, model: process.env.GROQ_MODEL ?? "openai/gpt-oss-120b" })
      : null;
    const research = () =>
      llm
        ? llm.research(QUESTIONS[Math.floor(Math.random() * QUESTIONS.length)]!).catch((e: Error) => {
            console.error(`[researcher] llm failed (${e.message}); one scripted search instead`);
            return scripted();
          })
        : scripted();
    // A question every 30-60 min, up to 3 paid calls each (about 0.25 SUI of gas a day), often from more than one vendor.
    runs.push(loop(research, () => jitter(llm ? 30 * 60_000 : 8 * 60_000, llm ? 60 * 60_000 : 20 * 60_000)));
  }
  if (which === "all" || which === "pricebot") {
    const a = agent("pricebot");
    // Steady schedule. Each payment costs ~0.003 SUI of gas, so every 25 min keeps a multi-day run affordable.
    runs.push(loop(() => a.call(`${api}/price/SUI`), () => 25 * 60_000));
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

/**
 * Simulated run: the real Warden engine (rules, learning, memory) over 14
 * simulated days. Only the chain, Walrus Memory (MemWalMock) and Telegram are
 * stand-ins, and a scripted owner answers escalations. Writes state for the
 * dashboard to `.warden/sim/`.
 *
 *   pnpm --filter @warden/warden sim
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ConsoleChannel } from "@warden/bot";
import type { VaultActuator } from "../act/vault.js";
import { WardenMemory } from "../memory/store.js";
import { mockBackend } from "../memory/walrus.js";
import { PatternIntentParser } from "../policy/parser.js";
import { Warden } from "../warden.js";
import { addr, AGENT_IDS, FakeChain, FakeVault, PKG, VAULT, units } from "./fakes.js";

const DAYS = 14;
const STEP_MS = 15 * 60_000;
const start = Date.UTC(2026, 9, 22, 0);
const outDir = resolve(process.argv[2] ?? "../../.warden/sim");

// Deterministic RNG (mulberry32) so every run tells the same story.
let seed = 7;
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const searchVendors = Array.from({ length: 10 }, (_, i) => addr(0xa00 + i));
const priceFeed = addr(0xb00);
const btcFeed = addr(0xb01);

async function main(): Promise<void> {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const chain = new FakeChain();
  const vault = new FakeVault();
  const owner = new ConsoleChannel(false);
  const memory = new WardenMemory(mockBackend("warden-sim"), join(outDir, "memory.json"));
  let now = start;
  const warden = new Warden({
    chain: chain.asChain(),
    packageId: PKG,
    vaultId: VAULT,
    units,
    memory,
    vault: vault as unknown as VaultActuator,
    owner,
    parser: new PatternIntentParser(),
    log: () => {},
    now: () => now,
  });
  await warden.init();

  const feed: { ts: string; from: "warden" | "owner"; text: string }[] = [];
  let seenMsgs = 0;
  const ownerSays = async (input: Parameters<Warden["handleOwner"]>[0], label: string) => {
    feed.push({ ts: new Date(now).toISOString(), from: "owner", text: label });
    const reply = await warden.handleOwner(input);
    feed.push({ ts: new Date(now).toISOString(), from: "warden", text: reply });
  };

  const daily: Record<string, number> = {};
  const spend = (agent: string, to: string, usd: number, ts: number) => {
    if (vault.paused.has(AGENT_IDS[agent]!)) return chain.reject(agent, to, usd, ts);
    const k = `${agent}|${new Date(ts).toISOString().slice(0, 10)}`;
    daily[k] = (daily[k] ?? 0) + usd;
    chain.spend(agent, to, usd, ts, daily[k]);
  };

  let researcherPool = 1; // vendors the researcher knows about; grows over the first week
  for (let t = start; t < start + DAYS * 86_400_000; t += STEP_MS) {
    const dayN = Math.floor((t - start) / 86_400_000);
    const hourOfDay = new Date(t).getUTCHours();

    // pricebot: steady price feed every 30 min; on day 9 a config bug makes it poll 8× as often.
    if (t % (30 * 60_000) === 0) spend("pricebot", priceFeed, 0.001, t + 1_000);
    if (dayN === 9 && hourOfDay >= 12) for (let i = 0; i < 4; i++) spend("pricebot", priceFeed, 0.001, t + 2_000 + i * 1_000);

    // researcher: a few searches during working hours, discovering new vendors over the run.
    if (hourOfDay >= 8 && hourOfDay < 20 && rand() < 0.35) {
      if (rand() < 0.035 && researcherPool < searchVendors.length) researcherPool++;
      spend("researcher", searchVendors[Math.floor(rand() * researcherPool)]!, 0.002, t + 3_000);
    }

    // rogue: an hourly BTC price check… until day 5 at 14:00 when a retry bug makes it loop.
    if (t % 3_600_000 === 0) spend("rogue", btcFeed, 0.002, t + 4_000);
    if (dayN === 5 && hourOfDay === 14 && t % 3_600_000 === 0) {
      for (let i = 0; i < 40; i++) spend("rogue", searchVendors[0]!, 0.002, t + 5_000 + i * 2_000);
    }
    if (dayN === 5 && hourOfDay === 14 && t % 3_600_000 === STEP_MS) {
      for (let i = 0; i < 6; i++) spend("rogue", searchVendors[0]!, 0.002, t + i * 1_000);
    }

    now = t + STEP_MS - 1;
    const events = await warden.observe();
    await warden.recall(events);
    const items = warden.decide(await warden.assess(events));
    await warden.act(items);
    await warden.learn(items);

    // Scripted owner: answers each new message the way a busy owner would.
    for (; seenMsgs < owner.sent.length; seenMsgs++) {
      const msg = owner.sent[seenMsgs]!;
      feed.push({ ts: new Date(now).toISOString(), from: "warden", text: msg.text });
      const buttons = msg.buttons?.flat() ?? [];
      const pick = (s: string) => buttons.find((b) => b.data.endsWith(`:${s}`));
      if (!buttons.length) continue;
      if (msg.text.includes("Paused")) {
        await ownerSays({ kind: "button", data: pick("keep")!.data }, "Keep paused");
      } else if (msg.text.includes("blocked by the vault") || msg.text.includes("normal")) {
        await ownerSays({ kind: "button", data: pick("once")!.data }, "Allow once");
      } else if (msg.text.includes("researcher") && rand() < 0.4) {
        await ownerSays({ kind: "button", data: pick("once")!.data }, "Allow once");
      } else {
        await ownerSays({ kind: "button", data: pick("always")!.data }, "Always allow");
      }
    }
    seenMsgs = owner.sent.length;

    // Owner policy moments, typed in plain English.
    if (t === start + 10 * 3_600_000) await ownerSays({ kind: "text", text: "Block anything over $20/day" }, "Block anything over $20/day");
    if (t === start + 2 * 86_400_000 + 9 * 3_600_000) {
      await ownerSays({ kind: "text", text: "Freeze an agent that pays the same API 50× in an hour" }, "Freeze an agent that pays the same API 50× in an hour");
    }
    if (dayN === 6 && t % 86_400_000 === 10 * 3_600_000) await ownerSays({ kind: "text", text: "/unpause rogue" }, "/unpause rogue");
  }

  now = start + DAYS * 86_400_000 + 60_000;
  await warden.learn([]); // close the last day
  await memory.flush();
  await memory.save();
  await writeFile(
    join(outDir, "meta.json"),
    JSON.stringify({ mode: "simulated", days: DAYS, generated: new Date().toISOString(), vaultCalls: vault.calls, feed: feed.filter((m) => !m.text.startsWith("📒")).slice(-200) }, null, 2),
  );
  const s = memory.stats();
  console.log(`simulated ${DAYS} days → ${s.records} records, ${s.walrusWrites} memory writes (mock) → ${outDir}`);
  for (const m of memory.list("metric").sort((a, b) => a.day.localeCompare(b.day))) {
    console.log(`  ${m.day}  payments ${String(m.events).padStart(3)}  silent ${String(m.auto_handled).padStart(3)}  questions ${m.escalations}  pauses ${m.pauses}  rules ${m.rules_learned}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

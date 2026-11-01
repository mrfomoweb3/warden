import { join } from "node:path";
import { ConsoleChannel, TelegramChannel, type OwnerChannel } from "@warden/bot";
import { createChain, keypairFrom, sleep, Units } from "@warden/shared";
import { startVisitorApi } from "./api.js";
import { X402RiskChecker } from "./act/riskcheck.js";
import { VaultActuator } from "./act/vault.js";
import { loadConfig } from "./config.js";
import { buildWardenGraph } from "./graph.js";
import { WardenMemory } from "./memory/store.js";
import { walrusBackend } from "./memory/walrus.js";
import { GroqAlertExplainer } from "./policy/explain.js";
import { GroqIntentParser, PatternIntentParser } from "./policy/parser.js";
import { VisitorRegistry } from "./visitors.js";
import { Warden } from "./warden.js";

const log = (m: string) => console.log(`${new Date().toISOString()} [warden] ${m}`);

async function main(): Promise<void> {
  const cfg = loadConfig();
  const chain = await createChain({ url: cfg.TATUM_SUI_RPC_URL, apiKey: cfg.TATUM_API_KEY, network: cfg.SUI_NETWORK });
  const units = new Units(cfg.VAULT_COIN_DECIMALS, cfg.VAULT_COIN_USD);
  const memory = new WardenMemory(walrusBackend(cfg), join(cfg.WARDEN_STATE_DIR, "memory.json"), log);
  const vault = new VaultActuator(
    chain,
    { packageId: cfg.VAULT_PACKAGE_ID, vaultId: cfg.VAULT_OBJECT_ID, coinType: cfg.VAULT_COIN_TYPE },
    units,
    cfg.WARDEN_PRIVATE_KEY ? keypairFrom(cfg.WARDEN_PRIVATE_KEY) : null,
    cfg.WARDEN_CAP_ID ?? null,
  );
  const owner: OwnerChannel =
    cfg.TELEGRAM_BOT_TOKEN && cfg.TELEGRAM_OWNER_CHAT_ID ? new TelegramChannel(cfg.TELEGRAM_BOT_TOKEN, cfg.TELEGRAM_OWNER_CHAT_ID, log) : new ConsoleChannel();
  const parser = cfg.GROQ_API_KEY ? new GroqIntentParser(cfg.GROQ_API_KEY, cfg.GROQ_MODEL) : new PatternIntentParser();
  const explainer = cfg.GROQ_API_KEY ? new GroqAlertExplainer(cfg.GROQ_API_KEY, cfg.GROQ_MODEL) : undefined;
  const risk =
    cfg.PAID_API_URL && cfg.X402_PAYER_KEY
      ? new X402RiskChecker(chain, keypairFrom(cfg.X402_PAYER_KEY), cfg.PAID_API_URL, units.fromUsd(0.05))
      : undefined;

  const warden = new Warden({
    chain,
    packageId: cfg.VAULT_PACKAGE_ID,
    vaultId: cfg.VAULT_OBJECT_ID,
    units,
    memory,
    vault,
    owner,
    parser,
    risk,
    explainer,
    log,
  });
  await warden.init();
  const graph = buildWardenGraph(warden);

  log(`watching vault ${cfg.VAULT_OBJECT_ID} on ${cfg.SUI_NETWORK} via ${cfg.TATUM_SUI_RPC_URL}`);
  log(`actuators: ${vault.live ? "LIVE" : "dry run"} · memory: ${cfg.MEMWAL_MODE} · owner: ${owner instanceof TelegramChannel ? "telegram" : "console"} · risk checks: ${risk ? "x402" : "off"} · llm: ${cfg.GROQ_API_KEY ? `groq ${cfg.GROQ_MODEL} (rules + alert explanations)` : "off (pattern parser)"}`);

  // "Try Warden" visitors: shadow-mode rules on the demo agents' real payments, in their own Walrus namespace.
  const visitors = new VisitorRegistry({
    stateFile: join(cfg.WARDEN_STATE_DIR, "visitors.json"),
    backend: walrusBackend({ ...cfg, MEMWAL_NAMESPACE: `${cfg.MEMWAL_NAMESPACE}-visitors` }),
    parser,
    explainer,
    client: chain.grpc,
    agents: () => warden.agentNames(),
    send: owner instanceof TelegramChannel ? (chatId, text, buttons) => owner.sendTo(chatId, text, buttons) : undefined,
    network: cfg.SUI_NETWORK,
    siteUrl: cfg.PUBLIC_URL,
    log: (m) => log(`visitors: ${m}`),
  });
  await visitors.init();
  if (owner instanceof TelegramChannel) {
    owner.setVisitorHandler((chatId, input) => visitors.handleChat(chatId, input));
    await owner
      .username()
      .then((u) => visitors.setBotUsername(u))
      .catch((e: Error) => log(`telegram getMe failed, visitor linking is off: ${e.message}`));
  }
  const api = startVisitorApi(visitors, cfg.WARDEN_API_PORT, log);

  void owner.listen((input) => warden.handleOwner(input));

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    owner.stop();
    api.close();
    log("flushing memory before exit…");
    warden.persistProgress();
    await memory.flush().catch(() => {});
    await memory.save();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // Adaptive polling: fast right after activity, backing off when idle (saves Tatum credits).
  let interval = cfg.POLL_FAST_MS;
  let lastCreditLog = "";
  while (!stopping) {
    try {
      const out = await graph.invoke({ events: [], contexts: [], assessed: [] });
      interval = out.events.length ? cfg.POLL_FAST_MS : Math.min(cfg.POLL_IDLE_MS, Math.round(interval * 1.5));
      if (out.events.length) log(`cycle: ${out.events.length} events, ${out.assessed?.length ?? 0} payments assessed`);
      // Shadow mode: never fails the cycle, never touches the vault.
      if (out.assessed?.length) await visitors.observe(out.assessed.map((a) => a.ctx)).catch((e: Error) => log(`visitors: ${e.message}`));
    } catch (e) {
      log(`cycle failed: ${(e as Error).stack ?? e}`);
      interval = cfg.POLL_IDLE_MS;
    }
    const credits = chain.meter.snapshot();
    const hourKey = new Date().toISOString().slice(0, 13);
    if (hourKey !== lastCreditLog) {
      lastCreditLog = hourKey;
      log(`tatum credits today: ${credits.credits} ${JSON.stringify(credits.calls)}`);
    }
    await sleep(interval);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

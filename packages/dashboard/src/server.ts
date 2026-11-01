/**
 * Warden dashboard: one page over Warden's state (the local cache of its Walrus
 * memories). Read-only, except /api/try/*, which proxies "Try Warden" visitors to Warden.
 *
 *   pnpm dashboard          # live: reads .warden/, plus on-chain agent status if the vault is configured
 *   pnpm dashboard:sim      # runs the 14-day simulation, then serves it
 */
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createChain, readAgents, Units, type SuiNetwork } from "@warden/shared";
import { describe, MemoryRecord, type RecordOf } from "@warden/warden/schema";

const here = dirname(fileURLToPath(import.meta.url));
const argState = process.argv.indexOf("--state");
const stateDir = resolve(argState > 0 ? process.argv[argState + 1]! : (process.env.WARDEN_STATE_DIR ?? "../../.warden"));
const port = Number(process.env.DASHBOARD_PORT ?? 4300);
const wardenApi = `http://127.0.0.1:${process.env.WARDEN_API_PORT ?? 4310}`;

interface Meta {
  mode: "simulated";
  days: number;
  generated: string;
  vaultCalls: string[];
  feed: { ts: string; from: "warden" | "owner"; text: string }[];
}

async function loadState() {
  const raw = JSON.parse(await readFile(join(stateDir, "memory.json"), "utf8")) as {
    entries: Record<string, { rev: number; record: unknown }>;
    pending: unknown[];
    written: number;
  };
  const meta = (await readFile(join(stateDir, "meta.json"), "utf8").then(JSON.parse).catch(() => null)) as Meta | null;
  const records = Object.values(raw.entries)
    .map((e) => MemoryRecord.safeParse(e.record))
    .flatMap((p) => (p.success ? [p.data] : []));
  const of = <T extends MemoryRecord["type"]>(t: T) => records.filter((r): r is RecordOf<T> => r.type === t);
  return { records, of, meta, written: raw.written, pending: raw.pending.length };
}

/** Paused agents: live from the vault when configured, else replayed from the simulation's vault calls. */
async function agentStatus(meta: Meta | null, profiles: RecordOf<"agent_profile">[]): Promise<Record<string, { paused: boolean; spentTodayUsd?: number; dailyCapUsd?: number }>> {
  const out: Record<string, { paused: boolean; spentTodayUsd?: number; dailyCapUsd?: number }> = {};
  if (!meta && process.env.VAULT_OBJECT_ID && process.env.TATUM_SUI_RPC_URL) {
    try {
      const chain = await createChain({ url: process.env.TATUM_SUI_RPC_URL, apiKey: process.env.TATUM_API_KEY, network: (process.env.SUI_NETWORK ?? "testnet") as SuiNetwork });
      const units = new Units(Number(process.env.VAULT_COIN_DECIMALS ?? 9), Number(process.env.VAULT_COIN_USD ?? 1));
      for (const a of await readAgents(chain, process.env.VAULT_OBJECT_ID)) {
        out[a.label] = { paused: a.paused, spentTodayUsd: units.toUsd(a.spentToday), dailyCapUsd: units.toUsd(a.dailyCap) };
      }
      return out;
    } catch {
      /* fall through to memory-derived status */
    }
  }
  const paused = new Set<string>();
  for (const c of meta?.vaultCalls ?? []) {
    const [op, id] = c.split(":");
    if (op === "pause") paused.add(id!);
    if (op === "unpause") paused.delete(id!);
  }
  for (const p of profiles) out[p.agent] = { paused: paused.has(p.agent_id) };
  return out;
}

async function state() {
  const s = await loadState();
  const metrics = s.of("metric").sort((a, b) => a.day.localeCompare(b.day));
  const rules = s.of("rule").sort((a, b) => a.created.localeCompare(b.created));
  const profiles = s.of("agent_profile").sort((a, b) => a.agent.localeCompare(b.agent));
  const incidents = s.of("incident").sort((a, b) => b.created.localeCompare(a.created));
  const status = await agentStatus(s.meta, profiles);
  const sum = (k: "events" | "auto_handled" | "escalations" | "pauses" | "tightens" | "rules_learned") => metrics.reduce((n, m) => n + m[k], 0);
  const learned = rules.filter((r) => r.source !== "default");

  return {
    mode: s.meta ? "simulated" : "live",
    generated: s.meta?.generated ?? new Date().toISOString(),
    // Lets the page label the network and link the vault and every transaction to an explorer. Simulated runs have no chain.
    chain: s.meta ? null : { network: process.env.SUI_NETWORK ?? "testnet", vaultId: process.env.VAULT_OBJECT_ID ?? null, packageId: process.env.VAULT_PACKAGE_ID ?? null },
    totals: {
      payments: sum("events"),
      silent: sum("auto_handled"),
      questions: sum("escalations"),
      pauses: sum("pauses"),
      tightens: sum("tightens"),
      rulesLearned: learned.length,
      memoryWrites: s.written,
      pendingWrites: s.pending,
      records: s.records.length,
    },
    days: metrics.map((m) => ({
      day: m.day,
      payments: m.events,
      silent: m.auto_handled,
      questions: m.escalations,
      pauses: m.pauses,
      rulesTotal: learned.filter((r) => r.created.slice(0, 10) <= m.day).length,
    })),
    agents: profiles.map((p) => ({
      agent: p.agent,
      ...(status[p.agent] ?? { paused: false }),
      normalDailyUsd: p.normal_daily_spend_usd,
      daysObserved: p.days_observed,
      counterparties: p.typical_counterparties.length,
      peakPerHour: p.calls_per_hour_p95,
      openIncidents: incidents.filter((i) => i.agent === p.agent && i.status === "open").length,
    })),
    rules: rules.map((r) => ({ id: r.id, text: r.text, action: r.action, source: r.source, enabled: r.enabled, created: r.created, learnedFrom: r.learned_from, scope: r.scope })),
    incidents: incidents.slice(0, 40).map((i) => ({ id: i.id, agent: i.agent, what: i.what, action: i.action, status: i.status, outcome: i.outcome, created: i.created, tx: i.tx })),
    // Digests are already in the charts; the feed is for the question → reply → rule conversation.
    feed: s.meta?.feed.filter((m) => !m.text.startsWith("📒")).slice(-60).reverse() ?? [],
    memories: [...learned.slice(-4), ...incidents.slice(0, 3), ...s.of("feedback").slice(-3), ...profiles.slice(0, 2)].map(describe),
  };
}

/** "Try Warden": forwards /api/try/* to Warden's private visitor API on localhost. */
async function proxyTry(req: IncomingMessage, res: ServerResponse, rest: string): Promise<void> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 8_192) {
      res.writeHead(413, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ error: "Request too large." }));
    }
    chunks.push(c as Buffer);
  }
  try {
    const r = await fetch(`${wardenApi}/visitor/${rest}`, {
      method: req.method,
      headers: { "content-type": "application/json", ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}) },
      body: req.method === "POST" ? Buffer.concat(chunks) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
    res.writeHead(r.status, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(await r.text());
  } catch {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "Warden is restarting. Please try again in a minute." }));
  }
}

const PAGES: Record<string, string> = { "/": "landing.html", "/dashboard": "dashboard.html", "/try": "try.html" };
const ASSET_TYPES: Record<string, string> = { css: "text/css; charset=utf-8", webp: "image/webp", svg: "image/svg+xml", woff2: "font/woff2" };

const server = createServer(async (req, res) => {
  try {
    if (req.url === "/api/state") {
      const body = JSON.stringify(await state());
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(body);
    }
    const path = (req.url ?? "/").split(/[?#]/)[0]!;
    const tryRoute = /^\/api\/try\/([a-z/]+)$/.exec(path);
    if (tryRoute && (req.method === "GET" || req.method === "POST")) return await proxyTry(req, res, tryRoute[1]!);
    const page = PAGES[path];
    if (page) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(await readFile(join(here, "../public", page)));
    }
    const asset = /^\/([\w-]+\.(css|webp|svg|woff2))$/.exec(path);
    const body = asset && (await readFile(join(here, "../public", asset[1]!)).catch(() => null));
    if (asset && body) {
      res.writeHead(200, { "content-type": ASSET_TYPES[asset[2]!]!, "cache-control": "public, max-age=3600" });
      return res.end(body);
    }
    res.writeHead(404).end();
  } catch (e) {
    const missing = (e as NodeJS.ErrnoException).code === "ENOENT";
    res.writeHead(missing ? 503 : 500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: missing ? `No Warden state in ${stateDir} yet. Run Warden, or \`pnpm dashboard:sim\`.` : (e as Error).message }));
  }
});

server.listen(port, () => console.log(`[dashboard] http://localhost:${port}  (state: ${stateDir})`));

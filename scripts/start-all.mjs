/**
 * Runs the whole stack in one process tree, for single-service hosts like Render:
 * x402 paid APIs, Warden, the demo agents and the dashboard. They share one disk,
 * so the dashboard can read Warden's state. Crashed services restart with backoff;
 * SIGTERM is forwarded so Warden flushes its memory to Walrus before exiting.
 *
 *   node scripts/start-all.mjs
 *
 * PORT (set by the host) becomes the dashboard's port. RUN_AGENTS=false skips the demo agents.
 */
import { spawn } from "node:child_process";

const SERVICES = [
  { name: "paid-apis", pkg: "@warden/paid-apis", delayMs: 0 },
  { name: "warden", pkg: "@warden/warden", delayMs: 3_000 },
  { name: "dashboard", pkg: "@warden/dashboard", delayMs: 3_000, env: process.env.PORT ? { DASHBOARD_PORT: process.env.PORT } : {} },
  // Agents start last, once the paid APIs are listening.
  ...(process.env.RUN_AGENTS === "false" ? [] : [{ name: "agents", pkg: "@warden/agents", delayMs: 15_000 }]),
];

const children = new Map();
let stopping = false;

function start(svc, attempt = 0) {
  const child = spawn("pnpm", ["--filter", svc.pkg, "start"], { env: { ...process.env, ...svc.env }, stdio: ["ignore", "pipe", "pipe"] });
  children.set(svc.name, child);
  const prefix = (line) => line && console.log(`[${svc.name}] ${line}`);
  child.stdout.on("data", (b) => String(b).split("\n").forEach(prefix));
  child.stderr.on("data", (b) => String(b).split("\n").forEach(prefix));
  const startedAt = Date.now();
  child.on("exit", (code, signal) => {
    children.delete(svc.name);
    if (stopping) return;
    // A service that ran for a while gets a fresh backoff; one that keeps dying waits longer.
    const next = Date.now() - startedAt > 60_000 ? 0 : attempt + 1;
    const wait = Math.min(60_000, 2_000 * 2 ** next);
    console.log(`[supervisor] ${svc.name} exited (${signal ?? code}); restarting in ${wait / 1000}s`);
    setTimeout(() => start(svc, next), wait);
  });
}

for (const svc of SERVICES) setTimeout(() => !stopping && start(svc), svc.delayMs);
console.log(`[supervisor] starting ${SERVICES.map((s) => s.name).join(", ")}`);

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[supervisor] ${signal}: stopping services`);
  for (const child of children.values()) child.kill("SIGTERM");
  // Give Warden time to flush pending Walrus writes, then exit regardless.
  setTimeout(() => process.exit(0), 20_000).unref();
  const check = setInterval(() => children.size === 0 && (clearInterval(check), process.exit(0)), 250);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

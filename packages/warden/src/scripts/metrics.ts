/**
 * Prints the learning curve (escalations/day vs auto-handled) from Warden's
 * memory as CSV, for the blog chart and the demo.
 *
 *   pnpm --filter @warden/warden metrics > docs/learning-curve.csv
 */
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { WardenMemory } from "../memory/store.js";
import { walrusBackend } from "../memory/walrus.js";

const cfg = loadConfig();
const memory = new WardenMemory(walrusBackend(cfg), join(cfg.WARDEN_STATE_DIR, "memory.json"));
await memory.load();
if (process.argv.includes("--from-walrus")) await memory.rebuildFromWalrus(["metric", "rule"]);

const rules = memory.list("rule").filter((r) => r.source !== "default");
console.log("day,payments,auto_handled,auto_handled_pct,escalations,pauses,tightens,rules_learned,rules_total");
for (const m of memory.list("metric").sort((a, b) => a.day.localeCompare(b.day))) {
  const pct = m.events ? Math.round((100 * m.auto_handled) / m.events) : 0;
  const total = rules.filter((r) => r.created.slice(0, 10) <= m.day).length;
  console.log([m.day, m.events, m.auto_handled, pct, m.escalations, m.pauses, m.tightens, m.rules_learned, total].join(","));
}

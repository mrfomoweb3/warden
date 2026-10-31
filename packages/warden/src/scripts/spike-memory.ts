/**
 * Day-1 spike: one real Walrus Memory write + recall on mainnet with the
 * delegate key. Writes exactly one memory (a Warden boot record).
 *
 *   pnpm --filter @warden/warden spike:memory
 */
import { MemWal } from "@mysten-incubation/memwal";
import { requireEnv } from "@warden/shared";
import { encodeMemory } from "../memory/store.js";

const memwal = MemWal.create({
  key: requireEnv("MEMWAL_DELEGATE_KEY"),
  accountId: requireEnv("MEMWAL_ACCOUNT_ID"),
  serverUrl: process.env.MEMWAL_SERVER_URL ?? "https://relayer.memory.walrus.xyz",
  namespace: process.env.MEMWAL_NAMESPACE ?? "warden",
});

console.log("relayer:", (await memwal.health()).status, "· delegate public key:", await memwal.getPublicKeyHex());
const text = encodeMemory(
  { type: "metric", day: new Date().toISOString().slice(0, 10), events: 0, auto_handled: 0, escalations: 0, pauses: 0, tightens: 0, rules_learned: 0 },
  0,
);
const t = Date.now();
const r = await memwal.rememberAndWait(text, { idempotencyKey: `warden:spike:${new Date().toISOString().slice(0, 13)}` }, { timeoutMs: 120_000 });
console.log(`✓ remembered in ${Date.now() - t} ms → blob ${r.blob_id}`);
const hits = await memwal.recall({ query: "Warden metrics", limit: 3, sort: "recent" });
console.log(`✓ recall returned ${hits.total} hit(s):`, hits.results.map((h) => h.text.split("\n")[0]));
let count = 0;
let cursor: string | undefined;
for (let more = true; more; ) {
  const page = await memwal.listMemories({ cursor, namespace: process.env.MEMWAL_NAMESPACE ?? "warden" });
  count += page.memories.length;
  cursor = page.next_cursor ?? undefined;
  more = page.has_more;
}
console.log(`memories in namespace: ${count}`);

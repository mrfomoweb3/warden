import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RuleRecord } from "../src/memory/schema.js";
import { decodeMemory, encodeMemory, WardenMemory, type MemoryBackend } from "../src/memory/store.js";
import { mockBackend } from "../src/memory/walrus.js";

const rule: RuleRecord = {
  type: "rule",
  id: "rule_001",
  text: "Block anything over $20/day",
  scope: {},
  condition: { kind: "daily_over", usd: 20 },
  action: "tighten",
  tighten: { daily_usd: 20 },
  source: "telegram",
  created: "2026-10-22T09:00:00.000Z",
  enabled: true,
};

describe("memory encoding", () => {
  it("round-trips and starts with a readable sentence", () => {
    const text = encodeMemory(rule, 3);
    expect(text.split("\n")[0]).toContain('"Block anything over $20/day" → tighten');
    expect(decodeMemory(text)).toEqual({ record: rule, rev: 3 });
  });

  it("ignores foreign memories", () => {
    expect(decodeMemory("User prefers dark mode")).toBeNull();
  });
});

describe("WardenMemory", () => {
  it("rebuilds from Walrus with the newest revision winning", async () => {
    const backend = mockBackend("t1");
    const a = new WardenMemory(backend, null);
    a.put(rule);
    a.put({ ...rule, enabled: false });
    await a.flush();

    const b = new WardenMemory(backend, null);
    expect(await b.rebuildFromWalrus(["rule"])).toBeGreaterThan(0);
    expect(b.get("rule", "rule_001")?.enabled).toBe(false);
  });

  it("keeps failed writes queued, persists the queue, and retries", async () => {
    let fail = true;
    const written: string[] = [];
    const flaky: MemoryBackend = {
      async write(text) {
        if (fail) throw new Error("relayer down");
        written.push(text);
      },
      async recall() {
        return [];
      },
    };
    const path = join(await mkdtemp(join(tmpdir(), "warden-")), "memory.json");
    const a = new WardenMemory(flaky, path);
    a.put(rule);
    expect(await a.flush()).toEqual({ ok: 0, failed: 1 });
    await a.save();

    const b = new WardenMemory(flaky, path);
    await b.load();
    fail = false;
    expect(await b.flush()).toEqual({ ok: 1, failed: 0 });
    expect(written[0]).toContain("rule_001");
  });

  it("non-durable puts stay local", async () => {
    const m = new WardenMemory(mockBackend("t2"), null);
    m.put({ type: "cursor", key: "observer", event_cursor: null, updated: "x" }, { durable: false });
    expect(m.stats().pending).toBe(0);
  });
});

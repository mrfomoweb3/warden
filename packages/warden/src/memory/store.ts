import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, keyOf, MemoryRecord, type RecordOf, type RecordType } from "./schema.js";

/** Minimal surface Warden needs from Walrus Memory (satisfied by MemWal and MemWalMock). */
export interface MemoryBackend {
  write(text: string, idempotencyKey: string): Promise<void>;
  recall(query: string, limit: number): Promise<{ text: string; created_at?: string }[]>;
}

interface Entry {
  rev: number;
  record: MemoryRecord;
}

interface Pending {
  text: string;
  idempotencyKey: string;
  attempts: number;
}

interface CacheFile {
  entries: Record<string, Entry>;
  pending: Pending[];
  written: number;
}

const MARKER = "\n---warden ";

/** Serialises a record as a readable sentence followed by a machine-readable tail. */
export function encodeMemory(record: MemoryRecord, rev: number, at = new Date().toISOString()): string {
  return `${describe(record)}${MARKER}type=${record.type} key=${keyOf(record)} rev=${rev} at=${at}---\n${JSON.stringify(record)}`;
}

export function decodeMemory(text: string): { record: MemoryRecord; rev: number } | null {
  const i = text.indexOf(MARKER);
  if (i < 0) return null;
  const rest = text.slice(i + MARKER.length);
  const nl = rest.indexOf("\n");
  const meta = /rev=(\d+)/.exec(rest.slice(0, nl));
  try {
    const parsed = MemoryRecord.safeParse(JSON.parse(rest.slice(nl + 1)));
    if (!parsed.success) return null;
    return { record: parsed.data, rev: Number(meta?.[1] ?? 0) };
  } catch {
    return null;
  }
}

/**
 * Warden's memory. Every write goes to Walrus Memory (durable, portable) and to a
 * local cache (fast reads, survives relayer hiccups). Walrus writes are queued and
 * retried; the queue itself is persisted so a crash never drops a memory.
 */
export class WardenMemory {
  private entries = new Map<string, Entry>();
  private pending: Pending[] = [];
  private written = 0;
  private saveTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly backend: MemoryBackend,
    private readonly cachePath: string | null,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  async load(): Promise<void> {
    if (!this.cachePath) return;
    try {
      const data = JSON.parse(await readFile(this.cachePath, "utf8")) as CacheFile;
      for (const [k, e] of Object.entries(data.entries)) {
        const parsed = MemoryRecord.safeParse(e.record);
        if (parsed.success) this.entries.set(k, { rev: e.rev, record: parsed.data });
      }
      this.pending = data.pending ?? [];
      this.written = data.written ?? 0;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }

  /** Rebuilds state from Walrus Memory (e.g. fresh machine, or Claude Code added a rule). Newest rev wins. */
  async rebuildFromWalrus(types: RecordType[], perType = 100): Promise<number> {
    let merged = 0;
    for (const type of types) {
      const hits = await this.backend.recall(`Warden ${type.replace("_", " ")}`, perType);
      for (const hit of hits) {
        const d = decodeMemory(hit.text);
        if (!d || d.record.type !== type) continue;
        const k = `${type}:${keyOf(d.record)}`;
        const cur = this.entries.get(k);
        if (!cur || d.rev > cur.rev) {
          this.entries.set(k, d);
          merged++;
        }
      }
    }
    if (merged) this.scheduleSave();
    return merged;
  }

  get<T extends RecordType>(type: T, key: string): RecordOf<T> | undefined {
    return this.entries.get(`${type}:${key}`)?.record as RecordOf<T> | undefined;
  }

  list<T extends RecordType>(type: T): RecordOf<T>[] {
    const out: RecordOf<T>[] = [];
    for (const [k, e] of this.entries) if (k.startsWith(`${type}:`)) out.push(e.record as RecordOf<T>);
    return out;
  }

  /**
   * Stores a record. `durable: false` keeps it local only (used for the
   * high-churn cursor between periodic checkpoints).
   */
  put(record: MemoryRecord, opts: { durable?: boolean } = {}): void {
    const k = `${record.type}:${keyOf(record)}`;
    const rev = (this.entries.get(k)?.rev ?? 0) + 1;
    this.entries.set(k, { rev, record });
    if (opts.durable !== false) {
      this.pending.push({ text: encodeMemory(record, rev), idempotencyKey: `warden:${k}:${rev}`, attempts: 0 });
    }
    this.scheduleSave();
  }

  /** Semantic search over Walrus Memory (for the LLM and for Claude Code parity). */
  async search(query: string, limit = 8): Promise<string[]> {
    const hits = await this.backend.recall(query, limit);
    return hits.map((h) => h.text.split(MARKER)[0]!);
  }

  /** Pushes queued writes to Walrus Memory. Failed writes stay queued. */
  async flush(concurrency = 4): Promise<{ ok: number; failed: number }> {
    const batch = this.pending.splice(0, this.pending.length);
    let ok = 0;
    const retry: Pending[] = [];
    for (let i = 0; i < batch.length; i += concurrency) {
      await Promise.all(
        batch.slice(i, i + concurrency).map(async (p) => {
          try {
            await this.backend.write(p.text, p.idempotencyKey);
            ok++;
          } catch (e) {
            p.attempts++;
            this.log(`walrus write failed (attempt ${p.attempts}): ${(e as Error).message}`);
            retry.push(p);
          }
        }),
      );
    }
    this.pending.unshift(...retry);
    this.written += ok;
    if (batch.length) this.scheduleSave();
    return { ok, failed: retry.length };
  }

  stats(): { records: number; pending: number; walrusWrites: number } {
    return { records: this.entries.size, pending: this.pending.length, walrusWrites: this.written };
  }

  /** Saves are serialised: an explicit save and the debounced one never interleave. */
  save(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.saving = this.saving.then(() => this.writeCache(), () => this.writeCache());
    return this.saving;
  }
  private saving: Promise<void> = Promise.resolve();

  private async writeCache(): Promise<void> {
    if (!this.cachePath) return;
    const data: CacheFile = { entries: Object.fromEntries(this.entries), pending: this.pending, written: this.written };
    await mkdir(dirname(this.cachePath), { recursive: true });
    const tmp = `${this.cachePath}.tmp`;
    await writeFile(tmp, JSON.stringify(data));
    await rename(tmp, this.cachePath);
  }

  private scheduleSave(): void {
    if (!this.cachePath || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save().catch((e) => this.log(`cache save failed: ${(e as Error).message}`));
    }, 250);
  }
}

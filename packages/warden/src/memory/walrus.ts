import { MemWal, MemWalMock } from "@mysten-incubation/memwal";
import type { Config } from "../config.js";
import type { MemoryBackend } from "./store.js";

/** Walrus Memory on mainnet via the relayer. Writes return once the relayer accepts the job. */
export function walrusBackend(cfg: Config): MemoryBackend {
  if (cfg.MEMWAL_MODE === "mock") return mockBackend(cfg.MEMWAL_NAMESPACE);
  if (!cfg.MEMWAL_DELEGATE_KEY || !cfg.MEMWAL_ACCOUNT_ID) {
    throw new Error("MEMWAL_DELEGATE_KEY and MEMWAL_ACCOUNT_ID are required (or set MEMWAL_MODE=mock)");
  }
  const memwal = MemWal.create({
    key: cfg.MEMWAL_DELEGATE_KEY,
    accountId: cfg.MEMWAL_ACCOUNT_ID,
    serverUrl: cfg.MEMWAL_SERVER_URL,
    namespace: cfg.MEMWAL_NAMESPACE,
  });
  return {
    async write(text, idempotencyKey) {
      await memwal.remember(text, { idempotencyKey });
    },
    async recall(query, limit) {
      const r = await memwal.recall({ query, limit, sort: "recent" });
      return r.results;
    },
  };
}

export function mockBackend(namespace = "warden"): MemoryBackend {
  const mock = MemWalMock.create({ namespace });
  return {
    async write(text) {
      await mock.rememberAndWait(text);
    },
    async recall(query, limit) {
      return (await mock.recall({ query, limit })).results;
    },
  };
}

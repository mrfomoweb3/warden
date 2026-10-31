/**
 * Day-1 spike: confirms the Tatum Sui gRPC gateway answers every call Warden
 * uses (Sui's JSON-RPC is deprecated). Read-only.
 *
 *   pnpm --filter @warden/warden spike:tatum [address]
 *
 * TATUM_SUI_RPC_URL should be https://sui-<network>-grpc.gateway.tatum.io
 */
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { createChain, createGrpcClient, emitModuleFilter, queryVaultEvents, requireEnv, sleep, type SuiNetwork } from "@warden/shared";

const client = await createGrpcClient({
  url: requireEnv("TATUM_SUI_RPC_URL"),
  apiKey: process.env.TATUM_API_KEY,
  network: (process.env.SUI_NETWORK ?? "testnet") as SuiNetwork,
});
// gRPC only accepts full 32-byte hex addresses, so "0x5" must be padded.
const address = normalizeSuiAddress(process.argv[2] ?? process.env.OWNER_ADDRESS ?? "0x5");
const json = (x: unknown) =>
  JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? `<${v.length} bytes>` : v));

/** Runs one check, retrying with backoff when the gateway rate-limits (HTTP 429). */
async function step(name: string, fn: () => Promise<unknown>): Promise<void> {
  const t = Date.now();
  for (let attempt = 0; ; attempt++) {
    try {
      const out = await fn();
      console.log(`✓ ${name} (${Date.now() - t} ms)`, json(out).slice(0, 200));
      return;
    } catch (e) {
      const msg = (e as Error).message;
      if (/429|RESOURCE_EXHAUSTED/i.test(msg) && attempt < 3) {
        await sleep(2000 * 2 ** attempt);
        continue;
      }
      console.log(`✗ ${name}: ${msg}${attempt ? ` (after ${attempt} retries)` : ""}`);
      return;
    }
  }
}

/** Collects up to `limit` events from a ListEvents stream. */
async function events(filter: ReturnType<typeof emitModuleFilter> | undefined, from: bigint, limit: number) {
  const out: { type?: string; checkpoint?: bigint; tx?: string; module: string }[] = [];
  const call = client.ledgerService.listEvents({
    startCheckpoint: from,
    filter,
    options: { limit },
    readMask: { paths: ["package_id", "module", "event_type", "checkpoint", "transaction_digest"] },
  });
  for await (const frame of call.responses) {
    if (frame.event) out.push({ type: frame.event.eventType, checkpoint: frame.event.checkpoint, tx: frame.event.transactionDigest, module: `${frame.event.packageId}::${frame.event.module}` });
    if (frame.end) break;
  }
  return out;
}

let tip = 0n;
await step("LedgerService.GetServiceInfo", async () => {
  const r = (await client.ledgerService.getServiceInfo({})).response;
  tip = r.checkpointHeight ?? 0n;
  return { chain: r.chain, tip: r.checkpointHeight, lowestAvailable: r.lowestAvailableCheckpoint };
});
await step("StateService.GetBalance", async () => (await client.stateService.getBalance({ owner: address, coinType: "0x2::sui::SUI" })).response.balance);
await step("StateService.ListBalances", async () => (await client.stateService.listBalances({ owner: address })).response.balances.length + " coin types");

// A small window keeps the unfiltered scan cheap; Warden itself always filters by module.
const from = tip > 100n ? tip - 100n : 0n;
let sample: string | undefined;
await step("LedgerService.ListEvents (any, last ~100 checkpoints)", async () => {
  const out = await events(undefined, from, 3);
  sample = out[0]?.module;
  return out.map((e) => e.type);
});
if (sample) await step(`LedgerService.ListEvents (emitModule ${sample.slice(0, 14)}…)`, async () => (await events(emitModuleFilter(sample!), from, 2)).map((e) => e.type));
// Fallback if ListEvents is blocked: walk a shared object's version history. Every
// SpendVault call takes &mut Vault, so each one bumps the vault's version, and each
// version names the transaction that wrote it. Probed here on the Clock (0x6), which
// changes every checkpoint.
const clock = normalizeSuiAddress("0x6");
let prevTx: string | undefined;
let inputVersion: bigint | undefined;
await step("LedgerService.GetObject (latest, previous_transaction)", async () => {
  const o = (await client.ledgerService.getObject({ objectId: clock, readMask: { paths: ["version", "previous_transaction"] } })).response.object;
  prevTx = o?.previousTransaction;
  return { version: o?.version, previousTransaction: prevTx };
});
if (prevTx) await step("LedgerService.GetTransaction (events + effects)", async () => {
  const t = (await client.ledgerService.getTransaction({ digest: prevTx!, readMask: { paths: ["digest", "checkpoint", "timestamp", "events", "effects.changed_objects"] } })).response.transaction;
  inputVersion = t?.effects?.changedObjects.find((c) => c.objectId === clock)?.inputVersion;
  return { checkpoint: t?.checkpoint, events: t?.events?.events.length ?? 0, clockInputVersion: inputVersion };
});
if (inputVersion) await step("LedgerService.GetObject (past version)", async () => {
  const o = (await client.ledgerService.getObject({ objectId: clock, version: inputVersion, readMask: { paths: ["version", "previous_transaction"] } })).response.object;
  return { version: o?.version, previousTransaction: o?.previousTransaction };
});
if (prevTx) await step("LedgerService.BatchGetTransactions", async () => {
  const r = (await client.ledgerService.batchGetTransactions({ digests: [prevTx!], readMask: { paths: ["digest", "events"] } })).response;
  return `${r.transactions.length} result(s)`;
});
await step("LedgerService.ListTransactions (affected object)", async () => {
  const call = client.ledgerService.listTransactions({
    startCheckpoint: from,
    filter: { terms: [{ literals: [{ negated: false, predicate: { oneofKind: "affectedObject", affectedObject: { objectId: clock } } }] }] },
    options: { limit: 1 },
    readMask: { paths: ["digest"] },
  });
  for await (const frame of call.responses) if (frame.end) break;
  return "allowed";
});
await step("SubscriptionService.SubscribeCheckpoints (first frame)", async () => {
  const call = client.subscriptionService.subscribeCheckpoints({ readMask: { paths: ["sequence_number"] } });
  for await (const frame of call.responses) return { cursor: frame.cursor };
  return "no frames";
});

if (process.env.VAULT_PACKAGE_ID && process.env.VAULT_OBJECT_ID) {
  // The exact path Warden's observer uses.
  const chain = await createChain({ url: requireEnv("TATUM_SUI_RPC_URL"), apiKey: process.env.TATUM_API_KEY, network: (process.env.SUI_NETWORK ?? "testnet") as SuiNetwork });
  await step("queryVaultEvents (SpendVault, via ListTransactions)", async () => {
    const page = await queryVaultEvents(chain, process.env.VAULT_PACKAGE_ID!, process.env.VAULT_OBJECT_ID!, null, 10);
    return { events: page.data.map((e) => e.type.split("::").pop()), cursor: page.nextCursor, more: page.hasNextPage };
  });
}

// The checkpoint subscription keeps the gRPC channel open; exit once the checks are done.
process.exit(0);

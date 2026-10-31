import { describe, expect, it } from "vitest";
import { CreditMeter, encodeVaultEvent, parseVaultEvent, queryVaultEvents, type Chain } from "../src/index.js";

const PKG = "0x" + "a".repeat(64);
const VAULT = "0x" + "b".repeat(64);
const AGENT = "0x" + "c".repeat(64);
const TO = "0x" + "d".repeat(64);

/** A gateway that answers ListTransactions with the given frames and records the request. */
function chainWith(frames: unknown[]): { chain: Chain; requests: unknown[] } {
  const requests: unknown[] = [];
  const listTransactions = (req: unknown) => {
    requests.push(req);
    return {
      responses: (async function* () {
        yield* frames;
      })(),
    };
  };
  return { chain: { network: "testnet", meter: new CreditMeter(), grpc: { ledgerService: { listTransactions } } } as unknown as Chain, requests };
}

const spent = encodeVaultEvent(`${PKG}::vault::Spent`, {
  vault_id: VAULT,
  agent: AGENT,
  label: "pricebot",
  recipient: TO,
  amount: 1_000_000n,
  memo: Array.from(new TextEncoder().encode("nonce-1")),
  spent_today: 3_000_000n,
  timestamp_ms: 1_700_000_000_000n,
});

describe("queryVaultEvents over gRPC", () => {
  it("decodes SpendVault events from BCS, ignores other packages, and advances the cursor", async () => {
    const { chain, requests } = chainWith([
      {
        transaction: {
          digest: "D1",
          timestamp: { seconds: 1_700_000_000n, nanos: 0 },
          events: {
            events: [
              { eventType: `${PKG}::vault::Spent`, sender: AGENT, contents: { value: spent } },
              { eventType: "0x2::coin::CoinCreated", sender: AGENT, contents: { value: new Uint8Array([1]) } },
            ],
          },
        },
      },
      { watermark: { cursor: new Uint8Array([7, 7]), checkpoint: 42n }, end: { reason: 1 } },
    ]);

    const page = await queryVaultEvents(chain, PKG, VAULT, null);

    expect(page.data).toHaveLength(1);
    expect(page.hasNextPage).toBe(true); // ITEM_LIMIT: more to read
    expect(page.nextCursor).toEqual({ checkpoint: "42", after: "Bwc=" });
    const ev = parseVaultEvent(page.data[0]!, VAULT);
    expect(ev).toMatchObject({ kind: "spent", label: "pricebot", recipient: TO, amount: 1_000_000n, memo: "nonce-1", spentToday: 3_000_000n, digest: "D1" });
    expect(chain.meter.snapshot().calls).toEqual({ ListTransactions: 1 });
    expect(requests[0]).toMatchObject({ startCheckpoint: undefined, filter: { terms: [{ literals: [{ predicate: { affectedObject: { objectId: VAULT } } }] }] } });
  });

  it("resumes from a saved cursor and stops at the tip", async () => {
    const { chain, requests } = chainWith([{ end: { reason: 3 } }]);
    const page = await queryVaultEvents(chain, PKG, VAULT, { checkpoint: "42", after: "Bwc=" });

    expect(page).toEqual({ data: [], nextCursor: { checkpoint: "42", after: "Bwc=" }, hasNextPage: false });
    expect(requests[0]).toMatchObject({ startCheckpoint: 42n, options: { after: new Uint8Array([7, 7]) } });
  });

  it("drops events from a different vault of the same package", () => {
    const ev = { id: { txDigest: "D", eventSeq: "0" }, type: `${PKG}::vault::Spent`, sender: AGENT, parsedJson: { vault_id: "0x" + "e".repeat(64) } };
    expect(parseVaultEvent(ev, VAULT)).toBeNull();
  });
});

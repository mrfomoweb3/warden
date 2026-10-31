import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import type { Transaction } from "@mysten/sui/transactions";
import { GATEWAY_REJECTED, rpc, type Chain } from "./rpc.js";
import { decodeVaultEvent } from "./vault.js";

/** Accepts `suiprivkey1...` (as printed by `sui keytool export`). */
export function keypairFrom(secret: string): Ed25519Keypair {
  const { scheme, secretKey } = decodeSuiPrivateKey(secret.trim());
  if (scheme !== "ED25519") throw new Error(`unsupported key scheme ${scheme}; use an ed25519 key`);
  return Ed25519Keypair.fromSecretKey(secretKey);
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name} (see .env.example)`);
  return v;
}

export interface Executed {
  digest: string;
  /** Events with SpendVault payloads decoded from BCS (other events carry the gateway's JSON). */
  events: { type: string; parsedJson: Record<string, unknown> }[];
  /** Objects this transaction created, with their type and address owner (if any). */
  created: { objectId: string; type: string; owner?: string }[];
}

/** Signs and executes via Tatum's gRPC gateway, waits for effects, throws on Move abort. */
export async function execute(chain: Chain, signer: Ed25519Keypair, tx: Transaction): Promise<Executed> {
  // Building (object lookups, gas price, dry run) is read-only, so it retries freely.
  tx.setSenderIfNotSet(signer.toSuiAddress());
  const bytes = await rpc(chain, "BuildTransaction", () => tx.build({ client: chain.grpc }));
  const { signature } = await signer.signTransaction(bytes);
  // Execution retries only when the gateway rejected the request (429): a resend after a
  // timeout or upstream error could execute twice, but a rejected request never ran.
  const res = await rpc(
    chain,
    "ExecuteTransaction",
    () => chain.grpc.executeTransaction({ transaction: bytes, signatures: [signature], include: { effects: true, events: true, objectTypes: true } }),
    4,
    GATEWAY_REJECTED,
  );
  const t = res.Transaction ?? res.FailedTransaction;
  if (!res.Transaction) throw new Error(`tx ${t.digest} failed: ${t.status.success ? "unknown" : t.status.error.message}`);
  await rpc(chain, "WaitForTransaction", () => chain.grpc.waitForTransaction({ digest: t.digest }));
  const types = t.objectTypes ?? {};
  return {
    digest: t.digest,
    events: (t.events ?? []).map((e) => ({
      type: e.eventType,
      parsedJson: e.eventType.includes("::vault::") ? { ...(e.json ?? {}), ...decodeVaultEvent(e.eventType, e.bcs) } : (e.json ?? {}),
    })),
    created: (t.effects?.changedObjects ?? [])
      .filter((c) => c.idOperation === "Created")
      .map((c) => ({ objectId: c.objectId, type: types[c.objectId] ?? "", owner: c.outputOwner?.$kind === "AddressOwner" ? c.outputOwner.AddressOwner : undefined })),
  };
}

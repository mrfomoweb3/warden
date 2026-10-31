/**
 * One-time vault setup after `sui client publish` (run from packages/vault):
 * creates the vault, appoints the Warden, registers the three demo agents and
 * deposits funds. Prints the env lines to paste into .env.
 *
 *   OWNER_PRIVATE_KEY=suiprivkey1… VAULT_PACKAGE_ID=0x… pnpm --filter @warden/agents setup -- --deposit-usd 2
 *
 * Generates fresh keys for the warden and agents unless they are already in env.
 * Agents also need a little SUI for gas; this script sends each 0.05 SUI.
 */
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { coinWithBalance, Transaction } from "@mysten/sui/transactions";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { createChain, execute, keypairFrom, requireEnv, Units, type SuiNetwork } from "@warden/shared";

const chain = await createChain({ url: requireEnv("TATUM_SUI_RPC_URL"), apiKey: process.env.TATUM_API_KEY, network: (process.env.SUI_NETWORK ?? "testnet") as SuiNetwork });
const pkg = requireEnv("VAULT_PACKAGE_ID");
const coinType = process.env.VAULT_COIN_TYPE ?? "0x2::sui::SUI";
const units = new Units(Number(process.env.VAULT_COIN_DECIMALS ?? 9), Number(process.env.VAULT_COIN_USD ?? 1));
const owner = keypairFrom(requireEnv("OWNER_PRIVATE_KEY"));
const arg = (name: string, dflt: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : dflt;
};

const AGENTS = [
  { name: "researcher", perTxUsd: 0.05, dailyUsd: 1 },
  { name: "pricebot", perTxUsd: 0.01, dailyUsd: 0.5 },
  { name: "rogue", perTxUsd: 0.05, dailyUsd: 1 },
];

const created = (events: { type: string; parsedJson: unknown }[], suffix: string) =>
  events.find((e) => e.type.endsWith(suffix))?.parsedJson as Record<string, string> | undefined;

async function main(): Promise<void> {
  const keyFor = (env: string) => (process.env[env] ? keypairFrom(process.env[env]!) : new Ed25519Keypair());
  const warden = keyFor("WARDEN_PRIVATE_KEY");
  const agents = AGENTS.map((a) => ({ ...a, kp: keyFor(`${a.name.toUpperCase()}_PRIVATE_KEY`) }));

  // 1. vault
  let tx = new Transaction();
  tx.moveCall({ target: `${pkg}::vault::create`, typeArguments: [coinType] });
  const r1 = await execute(chain, owner, tx);
  const vaultId = created(r1.events, "::vault::VaultCreated")!.vault_id!;
  const ownerCap = r1.created.find((c) => c.type.endsWith("::vault::OwnerCap"));
  if (!ownerCap) throw new Error("OwnerCap not found");

  // 2. warden + agents + deposit + gas, in one PTB
  tx = new Transaction();
  tx.moveCall({ target: `${pkg}::vault::appoint_warden_to`, typeArguments: [coinType], arguments: [tx.object(ownerCap.objectId), tx.object(vaultId), tx.pure.address(warden.toSuiAddress())] });
  for (const a of agents) {
    tx.moveCall({
      target: `${pkg}::vault::add_agent_to`,
      typeArguments: [coinType],
      arguments: [tx.object(ownerCap.objectId), tx.object(vaultId), tx.pure.string(a.name), tx.pure.u64(units.fromUsd(a.perTxUsd)), tx.pure.u64(units.fromUsd(a.dailyUsd)), tx.pure.address(a.kp.toSuiAddress())],
    });
  }
  // coinWithBalance draws from the owner's address balance first (where the testnet
  // faucet now credits SUI), falling back to coins, so setup works either way.
  for (const a of agents) tx.transferObjects([coinWithBalance({ balance: 50_000_000n })], a.kp.toSuiAddress());
  tx.transferObjects([coinWithBalance({ balance: 50_000_000n })], warden.toSuiAddress());
  if (coinType.endsWith("::sui::SUI")) {
    const dep = coinWithBalance({ balance: units.fromUsd(arg("deposit-usd", 2)) });
    tx.moveCall({ target: `${pkg}::vault::deposit`, typeArguments: [coinType], arguments: [tx.object(vaultId), dep] });
  }
  const r2 = await execute(chain, owner, tx);
  const createdOf = (suffix: string, recipient: string) =>
    r2.created.find((c) => c.type.endsWith(suffix) && c.owner && normalizeSuiAddress(c.owner) === normalizeSuiAddress(recipient));

  const lines = [
    `VAULT_PACKAGE_ID=${pkg}`,
    `VAULT_OBJECT_ID=${vaultId}`,
    `VAULT_COIN_TYPE=${coinType}`,
    `OWNER_ADDRESS=${owner.toSuiAddress()}`,
    `WARDEN_PRIVATE_KEY=${warden.getSecretKey()}`,
    `WARDEN_CAP_ID=${createdOf("::vault::WardenCap", warden.toSuiAddress())?.objectId}`,
    ...agents.flatMap((a) => [`${a.name.toUpperCase()}_PRIVATE_KEY=${a.kp.getSecretKey()}`, `${a.name.toUpperCase()}_CAP_ID=${createdOf("::vault::SpenderCap", a.kp.toSuiAddress())?.objectId}`]),
  ];
  console.log(`\n# SpendVault ready (setup txs ${r1.digest}, ${r2.digest}). Add to .env:\n${lines.join("\n")}`);
  if (!coinType.endsWith("::sui::SUI")) console.log(`\n# Deposit ${coinType} into the vault with vault::deposit before running agents.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

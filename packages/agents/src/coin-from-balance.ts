/**
 * The testnet faucet now credits SUI to an address balance rather than as coin
 * objects, and older Sui CLIs can't pay gas from an address balance. This moves
 * part of the owner's address balance into a regular coin (owned by the owner),
 * so `sui client publish` has a gas coin to use.
 *
 *   OWNER_PRIVATE_KEY=suiprivkey1… pnpm --filter @warden/agents coin-from-balance -- --sui 0.5
 */
import { coinWithBalance, Transaction } from "@mysten/sui/transactions";
import { createChain, execute, keypairFrom, requireEnv, type SuiNetwork } from "@warden/shared";

const i = process.argv.indexOf("--sui");
const sui = i > 0 ? Number(process.argv[i + 1]) : 0.5;
const owner = keypairFrom(requireEnv("OWNER_PRIVATE_KEY"));
const chain = await createChain({ url: requireEnv("TATUM_SUI_RPC_URL"), apiKey: process.env.TATUM_API_KEY, network: (process.env.SUI_NETWORK ?? "testnet") as SuiNetwork });

const tx = new Transaction();
// useGasCoin: false makes the SDK withdraw from the address balance instead of a gas coin.
tx.transferObjects([coinWithBalance({ balance: BigInt(Math.round(sui * 1e9)), useGasCoin: false })], owner.toSuiAddress());
const r = await execute(chain, owner, tx);
const coin = r.created.find((c) => c.type.includes("::coin::Coin<"));
console.log(`✓ ${sui} SUI moved into coin ${coin?.objectId ?? "(see tx)"} for ${owner.toSuiAddress()} (tx ${r.digest})`);

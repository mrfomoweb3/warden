import { z } from "zod";

const Env = z.object({
  TATUM_API_KEY: z.string().optional(),
  TATUM_SUI_RPC_URL: z.string().url().default("https://sui-testnet-grpc.gateway.tatum.io"),
  SUI_NETWORK: z.enum(["mainnet", "testnet", "devnet", "localnet"]).default("testnet"),

  MEMWAL_MODE: z.enum(["live", "mock"]).default("live"),
  MEMWAL_DELEGATE_KEY: z.string().optional(),
  MEMWAL_ACCOUNT_ID: z.string().optional(),
  MEMWAL_SERVER_URL: z.string().url().default("https://relayer.memory.walrus.xyz"),
  MEMWAL_NAMESPACE: z.string().default("warden"),

  WARDEN_PRIVATE_KEY: z.string().optional(),
  WARDEN_CAP_ID: z.string().optional(),
  VAULT_PACKAGE_ID: z.string(),
  VAULT_OBJECT_ID: z.string(),
  VAULT_COIN_TYPE: z.string().default("0x2::sui::SUI"),
  VAULT_COIN_USD: z.coerce.number().positive().default(1),
  VAULT_COIN_DECIMALS: z.coerce.number().int().default(9),

  PAID_API_URL: z.string().url().optional(),
  X402_PAYER_KEY: z.string().optional(),

  GROQ_API_KEY: z.string().optional(),
  GROQ_MODEL: z.string().default("openai/gpt-oss-120b"),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_OWNER_CHAT_ID: z.string().optional(),

  POLL_FAST_MS: z.coerce.number().int().default(15_000),
  POLL_IDLE_MS: z.coerce.number().int().default(120_000),
  // Relative to the package dir (pnpm runs each package from its own folder): the repo-root .warden,
  // which is also where the dashboard reads from.
  WARDEN_STATE_DIR: z.string().default("../../.warden"),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`invalid configuration (see .env.example):\n${issues}`);
  }
  return parsed.data;
}

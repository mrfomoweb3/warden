import { promises as dns } from "node:dns";
import { ChannelCredentials, type ChannelOptions } from "@grpc/grpc-js";
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { GrpcTransport } from "@protobuf-ts/grpc-transport";
import type { SuiNetwork } from "./rpc.js";

/**
 * Sui gRPC client for the Tatum gateway (grpcs://sui-<network>-grpc.gateway.tatum.io:443).
 * Sui deprecated JSON-RPC in 2026 and Tatum's Sui JSON-RPC gateway no longer answers,
 * so this is the chain data path. The SDK's default transport is gRPC-web, which the
 * Tatum endpoint doesn't speak, so we hand it a native HTTP/2 gRPC transport instead.
 */
export async function createGrpcClient(opts: { url: string; apiKey?: string; network: SuiNetwork }): Promise<SuiGrpcClient> {
  const u = new URL(opts.url);
  const port = u.port || "443";
  const ip = await resolveIPv4(u.hostname);
  // When we resolved the address ourselves, dial the IP but keep TLS and HTTP/2
  // authority on the hostname so the certificate still verifies.
  const clientOptions: ChannelOptions = ip ? { "grpc.ssl_target_name_override": u.hostname, "grpc.default_authority": u.hostname } : {};
  const transport = new GrpcTransport({
    host: `${ip ?? u.hostname}:${port}`,
    channelCredentials: u.protocol === "http:" ? ChannelCredentials.createInsecure() : ChannelCredentials.createSsl(),
    clientOptions,
    meta: opts.apiKey ? { "x-api-key": opts.apiKey } : {},
  });
  return new SuiGrpcClient({ network: opts.network, transport });
}

/**
 * Returns an IPv4 address only when the system resolver can't find one. On some
 * machines the OS resolver intermittently returns nothing (or only IPv6) for the
 * Tatum gRPC host while public DNS answers, so fall back to Cloudflare, then Google.
 * Returns undefined when the system resolver works, leaving grpc-js to resolve normally.
 */
async function resolveIPv4(hostname: string): Promise<string | undefined> {
  try {
    await dns.lookup(hostname, { family: 4 });
    return undefined;
  } catch {
    /* fall through to public resolvers */
  }
  for (const server of ["1.1.1.1", "8.8.8.8"]) {
    try {
      const resolver = new dns.Resolver({ timeout: 3_000, tries: 2 });
      resolver.setServers([server]);
      const [ip] = await resolver.resolve4(hostname);
      if (ip) return ip;
    } catch {
      /* try the next resolver */
    }
  }
  throw new Error(`could not resolve ${hostname} (system DNS, 1.1.1.1 and 8.8.8.8 all failed)`);
}

/** Builds an EventFilter matching any of the given fully qualified modules (`0xpkg::module`). */
export function emitModuleFilter(...modules: string[]) {
  return {
    terms: modules.map((module) => ({
      literals: [{ negated: false, predicate: { oneofKind: "emitModule" as const, emitModule: { module } } }],
    })),
  };
}

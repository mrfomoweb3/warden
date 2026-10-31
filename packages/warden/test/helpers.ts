import { ConsoleChannel } from "@warden/bot";
import type { VaultActuator } from "../src/act/vault.js";
import { WardenMemory } from "../src/memory/store.js";
import { mockBackend } from "../src/memory/walrus.js";
import type { AlertExplainer } from "../src/policy/explain.js";
import { PatternIntentParser } from "../src/policy/parser.js";
import { FakeChain, FakeVault, PKG, units, VAULT } from "../src/sim/fakes.js";
import { Warden } from "../src/warden.js";

export { addr, AGENT_IDS, FakeChain, FakeVault, PKG, units, VAULT } from "../src/sim/fakes.js";

export async function makeWarden(start = Date.UTC(2026, 9, 22, 9), opts: { explainer?: AlertExplainer } = {}) {
  const chain = new FakeChain();
  const vault = new FakeVault();
  const owner = new ConsoleChannel(false);
  const memory = new WardenMemory(mockBackend(), null);
  let now = start;
  const warden = new Warden({
    chain: chain.asChain(),
    packageId: PKG,
    vaultId: VAULT,
    units,
    memory,
    vault: vault as unknown as VaultActuator,
    owner,
    parser: new PatternIntentParser(),
    explainer: opts.explainer,
    log: () => {},
    now: () => now,
  });
  await warden.init();
  const cycle = async () => {
    const events = await warden.observe();
    await warden.recall(events);
    const items = warden.decide(await warden.assess(events));
    await warden.act(items);
    await warden.learn(items);
    return items;
  };
  return { warden, chain, vault, owner, memory, cycle, tick: (ms: number) => (now += ms), now: () => now };
}

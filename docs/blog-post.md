# Warden: a watchdog for the wallets your AI agents spend from

*Built for Total Recall: Tatum × Walrus Memory. Code: [github.com/mrfomoweb3/warden](https://github.com/mrfomoweb3/warden). Live: [usewarden.fly.dev](https://usewarden.fly.dev).*

AI agents can pay for things now. With x402, an agent hits an API, gets a `402 Payment Required`, pays on-chain, and gets its data, no human in the loop. That's the point. It's also the problem: most of these agents pay from a hot key with no limits. Nothing stops an agent from paying the wrong address, paying too much, or paying the same API a thousand times because of a retry bug.

Warden is the missing layer. It watches every payment your agents make on Sui, learns what normal looks like for each one, and acts on-chain when something isn't normal. You tell it your rules once, in plain English. When it isn't sure, it asks you, and your answer becomes a rule, so it asks less over time.

## What it does

Agents don't pay from their own wallets. They pay through **SpendVault**, a small Move contract that holds each agent's allowance. The owner sets ceilings. Warden holds a `WardenCap`, which lets it pause an agent or lower its caps, but never move funds and never raise caps above what the owner allowed.

Every few seconds Warden runs one loop:

1. **Observe** the vault's transactions through Tatum's Sui gateway.
2. **Recall** the agent's normal spend, its usual counterparties and the active rules from Walrus Memory.
3. **Assess** each payment: amount, today's total, new counterparty, velocity, lookalike addresses.
4. **Decide**: allow silently, ask the owner, tighten caps or pause.
5. **Act** on-chain through SpendVault, or ask over Telegram.
6. **Learn** from the owner's reply and write everything to Walrus.

Every payment decision is deterministic code. A model (Groq-hosted `gpt-oss-120b`) does two things only: it turns your messages into rules, and it writes a one-line explanation under each alert. It is asked after Warden has already acted, so it can never delay a pause or talk Warden into allowing something.

## A real run

We deployed SpendVault to Sui testnet with three demo agents that pay x402 APIs: `researcher` (search), `pricebot` (a price feed) and `rogue`, which behaves until we make it loop.

When we let `rogue` loop, it paid the same search API every couple of seconds. On its 30th payment within 10 minutes, Warden's velocity rule fired and Warden **paused it on-chain** ([the pause transaction](https://suiscan.xyz/testnet/tx/FimJPaM3fQ5kw6NA29VmGSAg23xkar1NjGc71X9Ypju8)). No confirm button, no human. `rogue` kept trying, and the vault refused all 69 attempts while moving nothing. SpendVault doesn't abort a blocked spend; it emits `SpendRejected`, so Warden could see a paused agent still hammering and raise a second, quieter flag about it.

Warden also paid for its own due diligence. The first time an agent paid a counterparty it had never seen, Warden bought a risk check for that address from a paid API over x402, from its own small wallet ([one of those payments](https://suiscan.xyz/testnet/tx/88zNpyJAkCfGhQz6UgET8nnxMJb988Dh8qwGbvZPzdAR)). Agents paying agents, with a watchdog that pays for its own checks.

On the owner's side, everything arrives in Telegram: the agent, the counterparty, the amount, the transaction, and a plain-language explanation, with **Allow once**, **Always allow** and **Pause agent** buttons.

_add screenshot: docs/telegram-alerts.png_

## How it learned

Week one, Warden is cautious on purpose. It asks about every new counterparty. Each answer is stored in Walrus as feedback, and "Always allow" becomes a rule. After three approvals of new vendors for the same agent, Warden generalises: *"researcher may pay new counterparties up to $0.003 without asking"*, and it tells you it did.

_add chart: questions per day falling over the run (from `pnpm --filter @warden/warden metrics`)_

_add numbers: payments watched, % handled silently, questions asked, rules learned, over the multi-day run_

## Why Walrus Memory is the long-term record

Tatum's gateway is the live feed, and it keeps roughly three days of Sui history. That's fine for watching, but a watchdog that forgets everything after three days isn't much of a watchdog. So every rule, incident, owner reply, counterparty and daily baseline goes to Walrus Memory as it happens.

Each memory is a plain-English sentence with a JSON tail:

```text
Warden rule rule_004 (active, from feedback): "researcher may pay new counterparties up to $0.003 without asking (generalised from 3 approvals)" → allow (only for agent researcher).
---warden type=rule key=rule_004 rev=1 at=…---
{"type":"rule","id":"rule_004",...}
```

The sentence makes semantic recall useful, both for Warden and for you: with the Walrus Memory MCP server, Claude Code can answer "why was rogue paused?" from the same memories, including the alert's explanation. The JSON tail lets Warden rebuild its exact state.

We saw that work for real. When we moved Warden from a laptop to a fresh Fly.io machine with no local files, it started up, read Walrus, and **restored its rules, agent profiles, counterparties and its place in the chain**. Then it carried on where it left off. Walrus wasn't a log we wrote to; it was the agent's memory.

## How it uses Tatum

All chain data comes through Tatum's Sui gateway, and that part taught us the most. Sui deprecated JSON-RPC in 2026, and Tatum's Sui JSON-RPC endpoint stopped answering, so we moved Warden to **Tatum's Sui gRPC gateway**. Two things shaped the design:

- The gateway doesn't allow `ListEvents`. But every SpendVault function takes `&mut Vault`, so every spend, rejection, pause and cap change bumps the vault object. Warden lists the **transactions that touched the vault** with one `ListTransactions` call, filtered on the vault's object ID. That single query covers every agent, because they all spend through the same vault.
- Events are decoded from their BCS bytes against layouts that mirror the Move structs field for field, rather than from the gateway's JSON, which can differ between APIs.

Warden saves the gateway's own resume cursor, so a restart picks up exactly where it stopped. Calls go through a small rate limiter and a credit meter, and Warden polls every 15 seconds after activity, backing off to 2 minutes when things are quiet.

## What's next

- A mainnet SpendVault deployment.
- A public demo mode for the Telegram bot.
- The same engine for other wallets that need a watchdog: a person's own wallet (learning regular payees and flagging lookalike-address poisoning) or a small team treasury.

The code is open source: [github.com/mrfomoweb3/warden](https://github.com/mrfomoweb3/warden). The live dashboard is at [usewarden.fly.dev/dashboard](https://usewarden.fly.dev/dashboard).

Thanks to [@Tatum_io](https://x.com/Tatum_io) and [@WalrusFoundation](https://x.com/WalrusFoundation) for the infrastructure that made this possible.

# Warden — Build Plan (Total Recall: Tatum × Walrus Memory Hackathon)

> Working name: **Warden**. A spend watchdog for your AI agents' wallets on Sui.
> Track: **Smart Agents for Real Life**. Bonuses targeted: **Best Walrus Memory**, **Best Use of Agent Payments** (x402 on Sui).
> Submission deadline: **Mon 10 Nov 2026, 17:00 UTC (18:00 WAT)**. Judging 11–16 Nov, winners 17 Nov.

---

## 0. Instructions for Claude Code

- Read this whole file before writing code. Treat Section 2 (hard requirements) as non-negotiable.
- Stack is fixed by the hackathon rubric: **Walrus Memory on Sui mainnet** + **Tatum Sui RPC / Data API**. Do not swap in Mem0, Pinecone, Alchemy, QuickNode, viem, or EVM tooling. Use `@mysten/sui` for Sui.
- This is an **L3 autonomous agent**: persistent observe → reason → act loop, real actuators, long-term memory. The human sets goals and policy; Warden executes. **No confirm buttons between steps.** The only human touchpoint is an escalation that the learned policy explicitly calls for.
- Every external value (RPC URLs, x402 facilitator, Walrus SDK method names) marked `VERIFY` must be checked against current docs before use. Do not invent endpoints.
- Keep secrets in `.env`. Never commit keys. Ship `.env.example`.
- Write small, tested modules. Every actuator must be idempotent (safe to run twice).

---

## 1. The pitch (one paragraph)

AI agents now pay for APIs, data and services on their own via x402, and most run on a hot key with no spending controls. Warden watches every payment your agents make on Sui, learns each agent's normal behaviour, and enforces escalation rules you give it once in plain English ("block anything over $20/day", "ask me before any new counterparty", "freeze an agent that pays the same API 50× in an hour"). Rules and history live in **Walrus Memory**, so they follow your agents across Claude Code, Telegram and your own scripts. Week 1 it asks you about everything; by week 3 it handles almost everything alone and only interrupts when it matters.

---

## 2. Hard requirements (submission checklist)

- [ ] Walrus Memory integrated and **writing on Mainnet**
- [ ] **≥ 10 memories** stored on Mainnet (target 50+, real ones from the demo run)
- [ ] Tatum RPC used for onchain data (**Tatum Sui RPC** is scored inside "Technical Quality", 30%)
- [ ] x402 (or MPP) payments **settled on Sui** (for the Agent Payments bonus)
- [ ] Working demo (video + live link)
- [ ] Public repo with README
- [ ] Published blog post: what it does, how it uses Tatum + Walrus, **how it learned over time**
- [ ] Submission form fields: Tatum dashboard **account ID**, `MEMWAL_AGENT_ID` (public key under Delegate keys in the Walrus Memory dashboard)
- [ ] Bonus points: post on X / LinkedIn tagging @Tatum_io and @WalrusFoundation

### Judging weights → where we earn them
| Criterion | Weight | How Warden scores |
|---|---|---|
| Walrus + Tatum integration | 30% | Memory *is* the policy engine; Tatum Sui RPC is the only chain data source |
| Technical quality | 30% | Clean TS, tests, Move vault, successful Tatum Sui RPC integration |
| Creativity | 20% | Watchdog for *agents'* spending (not humans'), learned escalation rules |
| Presentation | 20% | Before/after demo: week-1 Warden vs. week-3 Warden |

---

## 3. Architecture

```
                ┌──────────────────────────────────────────────┐
                │                 WARDEN (LangGraph)            │
                │                                               │
  Tatum Sui ───▶│ OBSERVE ─▶ RECALL ─▶ ASSESS ─▶ DECIDE ─▶ ACT  │──▶ SpendVault (Move): pause / limit / allow
  RPC + Data    │    ▲                                    │     │──▶ Telegram: escalate / report
                │    └──────────── LEARN ◀────────────────┘     │──▶ x402 risk-check service (Warden pays)
                └───────────────────────┬──────────────────────┘
                                        │ read / write
                                 Walrus Memory (Mainnet)
                                        ▲
             Claude Code (Walrus Memory MCP) ┘  ← same memory, different tool (portability demo)

  Watched agents (3 demo agents) ──x402──▶ paid demo APIs (settled on Sui)
         └── spend only through SpendVault (so Warden can actually stop them)
```

### 3.1 Components

1. **`vault/` — SpendVault (Move, Sui mainnet)**
   - Holds stablecoin (or SUI) allowance per watched agent.
   - Roles: `OwnerCap` (human), `WardenCap` (Warden), per-agent `SpenderCap`.
   - Functions: `deposit`, `spend` (agent; enforces per-tx + daily cap and paused flag), `pause_agent` / `unpause_agent` (Warden), `set_caps` (Warden, within owner's max), `withdraw` (owner only).
   - Emits events for every spend, pause and cap change (Warden reads these via Tatum).
   - **Why:** without this, Warden can only alert. With it, Warden *acts*. This is what makes it L3.

2. **`agents/demo/` — three watched agents (TS)**
   - `researcher`: pays a paid search/data API via x402 a few times an hour.
   - `pricebot`: pays a price-feed endpoint on a steady schedule.
   - `rogue`: behaves normally, then is scripted to loop on an API (the anomaly we catch live).
   - Each pays through SpendVault, so every payment is visible and stoppable.

3. **`paid-apis/` — x402 demo services**
   - Small HTTP services that answer `402 Payment Required` and settle on Sui. Used only if no suitable live x402-on-Sui services exist. `VERIFY` which facilitator/SDK supports x402 on Sui (see Section 8).

4. **`warden/` — the agent (TS, LangGraph JS)**
   - **OBSERVE**: poll Tatum Sui RPC (`https://sui-mainnet.gateway.tatum.io/`, confirmed by Tatum team) — `suix_queryEvents` for SpendVault events, `suix_queryTransactionBlocks` + `sui_getTransactionBlock` for agent wallet history, `suix_getBalance` / `suix_getAllBalances` for balances. Cursor-based, cursor stored in Walrus Memory so restarts resume. **No Tatum Notifications for Sui** — polling only.
   - **Credit budget (Tatum free plan: 100K credits, ~420 used on 22 Oct):** one `suix_queryEvents` call per cycle on the SpendVault package covers *all* agents, because every agent spends through the vault. Poll interval is configurable and adaptive: 15s right after activity, backing off to 120s when idle. Balance/history calls only when an event needs them. Log credits used per day to the console and dashboard. `VERIFY` credits per RPC call and the monthly reset date.
   - **Retention constraint (confirmed by Tatum):** the gateway keeps only ~3 days (current epoch) of Sui history. Warden must never fall more than ~2 days behind, and every observed payment must be summarised into Walrus Memory as it happens. **Walrus Memory is the agent's long-term record; the chain gateway is only the live feed.** Use this line in the demo and blog post.
   - **RECALL**: fetch from Walrus Memory: agent profile, counterparty record, active rules, recent incidents.
   - **ASSESS**: deterministic checks first (caps, velocity, new counterparty, lookalike address), then LLM judgement for fuzzy cases. Paid risk check via x402 for unknown counterparties.
   - **DECIDE**: map assessment + rules → one of `allow`, `tighten`, `pause`, `escalate`. Rules are data, not code.
   - **ACT**: call SpendVault / send Telegram message / write incident.
   - **LEARN**: turn human replies into new or updated rules; update baselines; write everything to Walrus Memory.

5. **`bot/` — Telegram interface**
   - Owner sets policy in plain English. Warden escalates here and posts a daily digest.
   - Escalations are **only** sent when a rule demands it; no per-step confirmations.

6. **`dashboard/` (optional, week 3)**
   - One page: agents, spend vs. baseline, rules learned over time, incidents. Good for the video and the "learned over time" blog section.

### 3.2 Second mode (added after Tatum feedback: "find additional use cases")

Same loop, same memory schema, different watched wallet. Pick **one** for week 3 after the core works:
- **Personal wallet mode:** watch a human's Sui wallet — learn regular payees, flag poisoned lookalike addresses and dust senders, escalate unusual outflows.
- **Team treasury mode:** watch a small team/DAO wallet — learn who usually gets paid and how much, escalate off-pattern payouts.

Only a config switch + a few extra checks; do not fork the codebase. In the demo, show it in under 20 seconds as "one engine, any wallet that needs a watchdog."

---

## 4. Walrus Memory schema

Every memory is a small JSON record with a `type`. Keep them human-readable so the demo can show them.

| type | key | example content |
|---|---|---|
| `agent_profile` | agent id | `{ agent: "pricebot", normal_daily_spend: 1.40, typical_counterparties: [...], active_hours: "00-24", calls_per_hour_p95: 12 }` |
| `counterparty` | address | `{ address: "0x…", label: "price-feed API", first_seen, trust: 0.92, risk_check: {...} }` |
| `rule` | rule id | `{ text: "Ask me before any new counterparty over $5", parsed: { if: {...}, then: "escalate" }, source: "telegram", created }` |
| `incident` | incident id | `{ agent: "rogue", what: "52 calls to X in 40 min", action: "paused", resolved_by: "owner", outcome: "confirmed bug" }` |
| `feedback` | decision id | `{ decision: "escalated", owner_reply: "fine, always allow this one", rule_change: "rule_014" }` |
| `cursor` | "observer" | `{ last_checkpoint / last_event_cursor }` |

**Learning loop (this is what wins Best Walrus Memory):**
- Every owner reply creates `feedback` and usually a new or updated `rule`.
- Baselines in `agent_profile` update daily from observed spend.
- Escalation count per day should visibly fall across the demo run. Track it and show the chart.

---

## 5. Three-week schedule

### Week 1 — Foundations (Wed 22 Oct → Tue 28 Oct)
- [ ] Day 1: **spikes** (Section 8). Confirm x402-on-Sui path, Walrus Memory SDK write/read on mainnet, Tatum Sui RPC endpoint + event queries.
- [ ] Repo scaffold: pnpm workspace (`vault`, `warden`, `agents`, `paid-apis`, `bot`), TS strict, vitest, eslint.
- [ ] SpendVault Move module: caps, pause, events. Unit tests. Deploy to testnet.
- [ ] Observer: read SpendVault events + agent tx history via Tatum Sui RPC, with persistent cursor.
- [ ] Walrus Memory client wrapper (`remember`, `recall`, `search`) + first real mainnet writes.
- [ ] One demo agent paying one x402 endpoint end to end.
- **Exit check:** a payment happens → Warden sees it via Tatum → writes a memory on mainnet.
- **Team touchpoint:** post the one-liner + ask the open questions in Tatum Discord office hours (see TEAM_OUTREACH notes).

### Week 2 — The brain (Wed 29 Oct → Tue 4 Nov)
- [ ] LangGraph loop: OBSERVE → RECALL → ASSESS → DECIDE → ACT → LEARN, running continuously.
- [ ] Deterministic checks: per-tx cap, daily cap, velocity, new counterparty, lookalike-address detection.
- [ ] Rule parser: plain English → structured rule (LLM + JSON schema validation). Rules stored in Walrus.
- [ ] Actuators: pause / tighten / allow on SpendVault; Telegram escalation; x402 risk check for unknown counterparties.
- [ ] All three demo agents running; `rogue` scenario reproducible on command.
- [ ] Portability demo: Walrus Memory MCP in Claude Code reads Warden's rules and history.
- [ ] **Mon 3 Nov: competitor check.** Look at what others are building/sharing in the hackathon Discord and on X. Ask: is anything better than Warden? If yes, add the feature that beats it in week 3.
- **Exit check:** rogue agent loops → Warden pauses it within one cycle, escalates once, learns from the reply.
- **Team touchpoint:** share a 60-second screen recording with the Tatum/Walrus team and ask for feedback before the deadline.

### Week 3 — Proof and polish (Wed 5 Nov → Mon 10 Nov)
- [ ] Move SpendVault to **mainnet**. Run the full demo on mainnet for 2–3 days to accumulate real memories (target 50+).
- [ ] Learning metrics: escalations/day, auto-handled %, rules learned. Chart them.
- [ ] Optional dashboard page.
- [ ] Demo video (≤ 3 min): problem → setup in plain English → normal day → rogue agent caught → owner reply becomes a rule → same situation handled silently next time → memory opened in Claude Code.
- [ ] README: architecture, setup, env vars, how to run the demo.
- [ ] Blog post (publish publicly): what it does, how it uses Tatum + Walrus, **how it learned over time** with the chart.
- [ ] X / LinkedIn post tagging @Tatum_io and @WalrusFoundation.
- [ ] Submit by **Mon 10 Nov, 17:00 UTC**. Aim to submit Sun 9 Nov.

---

## 6. Repo layout

```
warden/
├─ BUILD_PLAN.md
├─ README.md
├─ .env.example
├─ packages/
│  ├─ vault/          # Move package: SpendVault
│  ├─ warden/         # LangGraph agent: observe/recall/assess/decide/act/learn
│  │  ├─ src/observe/ # Tatum Sui RPC client, event cursor
│  │  ├─ src/memory/  # Walrus Memory wrapper + schema types
│  │  ├─ src/policy/  # rule parser, deterministic checks
│  │  ├─ src/act/     # vault actuators, telegram, x402 risk check
│  │  └─ src/graph.ts # LangGraph wiring
│  ├─ agents/         # researcher, pricebot, rogue
│  ├─ paid-apis/      # x402 demo services (only if needed)
│  ├─ bot/            # Telegram interface
│  └─ dashboard/      # optional
└─ docs/
   ├─ blog-post.md
   └─ demo-script.md
```

---

## 7. Environment variables (`.env.example`)

```
# Tatum
TATUM_API_KEY=
TATUM_SUI_RPC_URL=https://sui-mainnet.gateway.tatum.io/   # confirmed by Tatum team
TATUM_ACCOUNT_ID=             # needed on the submission form

# Walrus Memory
MEMWAL_AGENT_ID=              # public key under Delegate keys (memory.walrus.xyz/dashboard)
MEMWAL_DELEGATE_KEY=          # VERIFY name/format in docs.wal.app/walrus-memory

# Sui
SUI_NETWORK=testnet           # switch to mainnet in week 3
WARDEN_PRIVATE_KEY=           # holds WardenCap only
OWNER_ADDRESS=
VAULT_PACKAGE_ID=
VAULT_OBJECT_ID=

# x402
X402_FACILITATOR_URL=         # VERIFY Sui-compatible facilitator
X402_PAYER_KEY=               # Warden's own small wallet for paid risk checks

# LLM
GROQ_API_KEY=

# Telegram
TELEGRAM_BOT_TOKEN=
TELEGRAM_OWNER_CHAT_ID=
```

---

## 8. Day-1 spikes and open questions (resolve before building on them)

1. **x402 on Sui:** which facilitator / SDK settles x402 on Sui today? Is MPP the intended path? Ask in Tatum + Walrus Discord. Fallback: self-hosted x402 server settling on Sui.
2. ~~Walrus Memory SDK~~ **RESOLVED (29 Oct):** SDK is `@mysten-incubation/memwal` (`remember` / `recall` / `listMemories` / `restore`). Judges count memories across the whole MemWal account / delegate key (`MEMWAL_AGENT_ID`), not per namespace, so Warden's `warden` namespace counts in full. Mainnet write cost still to observe on the first real run.
3. ~~Tatum Sui RPC~~ **RESOLVED (Tatum team, 22 Oct):** gateway `https://sui-mainnet.gateway.tatum.io/` supports `suix_queryEvents`; no Sui Notifications; ~3-day history retention. Still check free-plan rate limits.
4. ~~Tatum Data API on Sui~~ **RESOLVED:** use the JSON-RPC gateway for balances (`suix_getBalance`, `suix_getAllBalances`, `suix_getCoins`, `suix_getAllCoins`) and history (`suix_queryTransactionBlocks`, `sui_getTransactionBlock`).
5. **Track 2 framing — RESOLVED with a nudge:** Tatum says it works but suggested finding additional use cases. Plan: keep agent-spend watchdog as the core, and show the same engine in a second mode (see Section 3.2).

---

## 9. Definition of done

- Warden runs unattended for 48h on mainnet, watching 3 agents.
- At least one real anomaly caught and acted on (pause) without human input.
- At least 5 rules learned from owner replies, each traceable in Walrus Memory.
- Escalations per day measurably lower at the end of the run than at the start.
- Same memory readable from Claude Code via Walrus Memory MCP.
- All Section 2 boxes ticked.

## 10. After the hackathon

Keep the repo public and keep building in public whatever the result. Next steps: support EVM agents through Tatum's multichain RPC, add AP2-style signed mandates, and get 10–50 real agent builders using it.

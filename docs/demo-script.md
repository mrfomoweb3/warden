# Demo script (≤ 3 min)

Before recording:
- In Telegram, send `/unpause rogue` so the loop scene can happen live.
- Open https://usewarden.fly.dev/dashboard in a browser tab.
- Have a terminal ready in the repo with `.env` loaded (for the rogue loop), and Suiscan open on the vault: https://suiscan.xyz/testnet/object/0x3b7388b0d82848c22a3bdf58fff56c96639d49a8e8278796473a638650113135

| t | Show | Say |
|---|---|---|
| 0:00 | Landing page (usewarden.fly.dev), then the dashboard's agents table | "These AI agents pay for APIs on their own, on Sui, over x402. Most agents like this run on a hot key with no limits." |
| 0:15 | Telegram: type *"block anything over $1/day"* | "I tell Warden my rules once, in plain English." Show the reply with the rule id and the on-chain `set_caps` tx. |
| 0:35 | Telegram: a ❓ question about a new counterparty with its 💬 explanation. Tap **Always allow** | "Week one, it asks about everything, and explains why in plain words. My answer becomes a rule." |
| 0:55 | Dashboard: Rules learned, showing the learned rule (and the generalised rule if you have one) | "After three approvals for one agent it generalises, and tells me so." |
| 1:15 | Terminal: `pnpm --filter @warden/agents rogue` (rogue loops every 2s) | "This agent has a retry bug." |
| 1:30 | Telegram: ⛔ *Paused rogue: paid … 30× in 10 min*, with the vault tx and its 💬 explanation. Rogue's terminal shows *vault blocked payment* | "Warden paused it on-chain within one cycle, with no confirm button. The agent keeps trying and the vault refuses." Stop the loop (Ctrl-C). |
| 1:55 | Suiscan: the pause transaction on the vault | "That's a real transaction on Sui, by Warden's own key." |
| 2:05 | Dashboard: questions-per-day chart falling across the run | "Questions to me per day over the run. It asks less as it learns." |
| 2:25 | Claude Code with the Walrus Memory MCP: "why was rogue paused?" | "The memory isn't locked inside Warden. Same memories, different tool." |
| 2:45 | Dashboard "Memories on Walrus" count, then the README architecture diagram | "Tatum is the live feed, with a 3-day window. Walrus Memory is the long-term record: Warden even restored itself from Walrus on a fresh server." |

After recording, rogue stays paused (Warden paused it in the loop scene). Send `/unpause rogue` if you want it back on its normal schedule.

# Demo script (≤ 3 min)

| t | Show | Say |
|---|---|---|
| 0:00 | Terminal: three agents paying x402 APIs, tx digests scrolling | "These agents pay for APIs on their own. Most run on a hot key with no limits." |
| 0:15 | Telegram: type *"Block anything over $20/day"* and *"ask me before any new counterparty over $5"* | "I tell Warden my rules once, in plain English." Show the reply with the rule id and the on-chain `set_caps` tx. |
| 0:35 | Telegram, week-1 (first metric day): escalations for researcher's new search vendors → tap **Always allow** ×3 | "Week one, it asks about everything." On the third tap, Warden posts 🧠 *"new rule: researcher may pay new counterparties up to $0.003 without asking."* |
| 1:00 | Next new vendor: no message; the console shows `allow (suppressed default_new_counterparty by rule_004)` | "Same situation, handled silently. It learned." |
| 1:20 | `pnpm --filter @warden/agents rogue`: rogue loops every 2s | "This agent has a retry bug." |
| 1:35 | Telegram: ⛔ *Paused rogue: paid 0x…  30× in 10 min*, with the vault tx. Then the rogue console shows *vault blocked payment*. | "Warden paused it on-chain within one cycle, with no confirm button. The agent keeps trying and the vault refuses." |
| 1:55 | Tap **Keep paused**, then `/digest` | "One question to me, not thirty." |
| 2:10 | Chart from `pnpm metrics`: escalations/day falling, auto-handled % rising | "Escalations per day over the run." |
| 2:30 | Claude Code + Walrus Memory MCP: "why was rogue paused?" → the incident and rule memories | "The memory isn't locked in Warden. Same memory, different tool." |
| 2:45 | Explorer: Walrus Memory count, SpendVault events | "Tatum is the live feed (3-day window); Walrus Memory is the long-term record." |

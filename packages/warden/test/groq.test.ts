import { afterEach, describe, expect, it, vi } from "vitest";
import { GroqIntentParser } from "../src/policy/parser.js";

/** Stubs fetch with one Groq chat-completions reply and returns the captured request. */
function groqReplies(content: unknown, status = 200) {
  const calls: { url: string; body: Record<string, unknown>; auth: string | null }[] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get("authorization") });
    const body = status === 200 ? { choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }] } : { error: { message: "invalid api key" } };
    return new Response(JSON.stringify(body), { status });
  });
  return calls;
}

const ctx = { agents: ["researcher", "pricebot", "rogue"] };

afterEach(() => vi.unstubAllGlobals());

describe("GroqIntentParser", () => {
  it("turns a plain-English cap into an on-chain tighten rule", async () => {
    const calls = groqReplies({
      intent: "rule", decision: null, condition_kind: "daily_over", usd: 20, count: null, window_min: null, factor: null, min_score: null,
      agent: null, counterparty: null, amount_min_usd: null, amount_max_usd: null, action: "tighten", tighten_per_tx_usd: null, tighten_daily_usd: 20,
      summary: "Cap every agent at $20/day.",
    });
    const out = await new GroqIntentParser("gsk_test", "test-model").parse("block anything over $20/day", ctx);

    expect(out).toMatchObject({ intent: "rule", rule: { condition: { kind: "daily_over", usd: 20 }, action: "tighten", tighten: { daily_usd: 20 } } });
    expect(calls[0]).toMatchObject({ url: "https://api.groq.com/openai/v1/chat/completions", auth: "Bearer gsk_test", body: { model: "test-model", response_format: { type: "json_object" } } });
  });

  it("accepts replies that omit unused keys instead of writing null", async () => {
    groqReplies({ intent: "rule", condition_kind: "new_counterparty", action: "escalate", amount_min_usd: 5, summary: "Ask before new counterparties over $5." });
    const out = await new GroqIntentParser("k").parse("ask me before any new counterparty over $5", ctx);
    expect(out).toMatchObject({ intent: "rule", rule: { condition: { kind: "new_counterparty" }, action: "escalate", amount_min_usd: 5 } });
  });

  it("maps a reply to an open incident to a resolution", async () => {
    groqReplies({ intent: "resolve", decision: "always_allow", summary: "Always allow this vendor." });
    const out = await new GroqIntentParser("k").parse("that's fine, don't ask again", {
      ...ctx,
      incident: { id: "inc_1", agent: "researcher", what: "researcher paid a new counterparty", condition_kinds: ["new_counterparty"] },
    });
    expect(out).toEqual({ intent: "resolve", decision: "always_allow", summary: "Always allow this vendor." });
  });

  it("falls back to 'other' on unparseable output, and throws on API errors", async () => {
    groqReplies("not json");
    expect((await new GroqIntentParser("k").parse("hello", ctx)).intent).toBe("other");

    groqReplies(null, 401);
    await expect(new GroqIntentParser("bad").parse("hello", ctx)).rejects.toThrow(/groq 401/);
  });
});

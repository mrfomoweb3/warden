/**
 * The researcher as a real LLM agent. Given a question, the model decides which paid
 * API to call next and from which vendor; each call is paid from the agent's SpendVault
 * over x402, and the result goes back to the model until it writes a short answer.
 *
 * The model only picks from whitelisted tools with validated arguments: it never sees a
 * key, never builds a URL, and gets at most MAX_CALLS paid calls per question.
 */
import type { DemoAgent } from "./agent.js";

const MAX_CALLS = 3;

type Step = { action: "search"; vendor: string; q: string } | { action: "price"; symbol: string } | { action: "done"; answer: string };

export class LlmResearcher {
  constructor(
    private readonly agent: DemoAgent,
    private readonly api: string,
    private readonly vendors: string[],
    private readonly groq: { apiKey: string; model: string },
    private readonly log: (m: string) => void = (m) => console.log(`[researcher] ${m}`),
  ) {}

  async research(question: string): Promise<void> {
    const system =
      `You are a research agent with a small budget. Answer the question using paid data sources. ` +
      `Each request costs real money from your vault, so make at most ${MAX_CALLS} requests and stop as soon as you can answer.\n` +
      `search costs $0.002 and price $0.001. Search vendors differ in coverage: if one returns little, try another vendor or answer with what you have. ` +
      `Never repeat the same request. Call done with a one- or two-sentence answer when you can answer. ` +
      `Only state what the results say; if they don't answer the question, say that instead of guessing.`;
    const transcript: string[] = [`Question: ${question}`];
    for (let calls = 0; ; calls++) {
      // Out of budget: the model must answer with what it has.
      const step = await this.nextWithRetry(system, transcript, calls >= MAX_CALLS);
      if (!step || step.action === "done" || calls >= MAX_CALLS) {
        this.log(`answer to "${question}": ${step?.action === "done" ? step.answer : "(no answer: the model failed)"}`);
        return;
      }
      const url = step.action === "search" ? `${this.api}/search?vendor=${step.vendor}&q=${encodeURIComponent(step.q)}` : `${this.api}/price/${step.symbol}`;
      this.log(step.action === "search" ? `model chose search on ${step.vendor}: "${step.q}"` : `model chose price ${step.symbol}`);
      const result = await this.agent.call(url);
      transcript.push(`${JSON.stringify(step)} → ${result === null ? "failed (payment refused or API error)" : JSON.stringify(result).slice(0, 600)}`);
    }
  }

  /** The model occasionally skips the call or sends bad arguments: retry once, then end the run without paying more. */
  private async nextWithRetry(system: string, transcript: string[], mustFinish: boolean): Promise<Step | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.next(system, transcript, mustFinish);
      } catch (e) {
        if (attempt === 1) this.log(`model failed twice (${(e as Error).message.slice(0, 80)}); ending this question`);
      }
    }
    return null;
  }

  /** Asks the model for the next step; anything outside the whitelist ends the run. */
  private async next(system: string, transcript: string[], mustFinish: boolean): Promise<Step | null> {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.groq.apiKey}` },
      body: JSON.stringify({
        model: this.groq.model,
        temperature: 0.7,
        max_tokens: 1000,
        ...(this.groq.model.startsWith("openai/gpt-oss") ? { reasoning_effort: "low" } : {}),
        // Native function calling: the only things the model can do are these three calls.
        // Out of budget, there are no calls left: it answers in plain text.
        ...(mustFinish ? {} : { tools: toolsFor(this.vendors), tool_choice: "required" }),
        messages: [
          { role: "system", content: system },
          { role: "user", content: transcript.join("\n") + (mustFinish ? "\nYour budget is used up. Answer the question now in one or two sentences of plain text." : "") },
        ],
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`groq ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { choices?: { message?: { content?: string; tool_calls?: { function: { name: string; arguments: string } }[] } }[] };
    if (mustFinish) {
      const answer = body.choices?.[0]?.message?.content?.trim();
      if (!answer) throw new Error("the model gave no answer");
      return { action: "done", answer: answer.slice(0, 400) };
    }
    const call = body.choices?.[0]?.message?.tool_calls?.[0]?.function;
    if (!call) throw new Error("the model didn't choose a step");
    return validStep({ ...JSON.parse(call.arguments || "{}"), action: call.name }, this.vendors);
  }
}

function toolsFor(vendors: string[]) {
  const fn = (name: string, description: string, properties: Record<string, unknown>) => ({
    type: "function",
    function: { name, description, parameters: { type: "object", properties, required: Object.keys(properties) } },
  });
  return [
    fn("search", "Paid web search ($0.002), 5 results.", { vendor: { type: "string", enum: vendors }, q: { type: "string", description: "query, max 80 characters" } }),
    fn("price", "Paid spot price ($0.001).", { symbol: { type: "string", description: 'ticker, e.g. "SUI"' } }),
    fn("done", "Finish with the answer.", { answer: { type: "string", description: "one or two sentences" } }),
  ];
}

export function validStep(raw: unknown, vendors: string[]): Step | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  if (s.action === "search" && typeof s.vendor === "string" && vendors.includes(s.vendor) && typeof s.q === "string" && s.q.trim()) {
    return { action: "search", vendor: s.vendor, q: s.q.trim().slice(0, 80) };
  }
  if (s.action === "price" && typeof s.symbol === "string" && /^[A-Za-z]{2,6}$/.test(s.symbol)) return { action: "price", symbol: s.symbol.toUpperCase() };
  if (s.action === "done" && typeof s.answer === "string") return { action: "done", answer: s.answer.slice(0, 400) };
  return null;
}

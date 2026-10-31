/** Groq's OpenAI-compatible chat completions endpoint, shared by the rule parser and the alert explainer. */
export interface GroqConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

export async function groqChat(
  cfg: GroqConfig,
  messages: { role: "system" | "user"; content: string }[],
  opts: { json?: boolean; maxTokens?: number; timeoutMs?: number } = {},
): Promise<string> {
  const res = await fetch(`${cfg.baseUrl ?? "https://api.groq.com/openai/v1"}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0,
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      // gpt-oss models reason before answering; keep that short so it doesn't eat the token budget.
      ...(cfg.model.startsWith("openai/gpt-oss") ? { reasoning_effort: "low" } : {}),
      ...(opts.json ? { response_format: { type: "json_object" } } : {}),
      messages,
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
  });
  if (!res.ok) throw new Error(`groq ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return body.choices?.[0]?.message?.content ?? "";
}

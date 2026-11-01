/**
 * Warden's private HTTP API for "Try Warden" visitors. It listens on localhost only;
 * the dashboard server proxies /api/try/* to it, so the public site never talks to
 * the Warden process directly.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { VisitorError, type VisitorRegistry } from "./visitors.js";

const MAX_BODY = 8_192;

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY) throw new VisitorError("Request too large.", 413);
  }
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    throw new VisitorError("Invalid JSON.");
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function startVisitorApi(visitors: VisitorRegistry, port: number, log: (m: string) => void): Server {
  const server = createServer(async (req, res) => {
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(data));
    };
    try {
      const path = (req.url ?? "/").split("?")[0]!;
      const auth = () => visitors.authenticate(/^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1]);
      const route = `${req.method} ${path}`;
      switch (route) {
        case "GET /visitor/nonce":
          return send(200, visitors.issueNonce());
        case "POST /visitor/login": {
          const b = await body(req);
          const { token, address } = await visitors.login(str(b.address), str(b.message), str(b.signature));
          return send(200, { token, me: visitors.view(visitors.get(address)!) });
        }
        case "GET /visitor/me":
          return send(200, visitors.view(auth()));
        case "POST /visitor/agent": {
          const v = auth();
          const b = await body(req);
          return send(200, visitors.view(await visitors.setAgent(v, str(b.name), str(b.watches))));
        }
        case "POST /visitor/rule": {
          const v = auth();
          const b = await body(req);
          const { rule, summary } = await visitors.addRule(v, str(b.text));
          return send(200, { rule: { id: rule.id, text: rule.text, action: rule.action }, summary, me: visitors.view(v) });
        }
        case "POST /visitor/rule/delete": {
          const v = auth();
          const b = await body(req);
          await visitors.deleteRule(v, str(b.id));
          return send(200, visitors.view(v));
        }
        case "POST /visitor/telegram":
          return send(200, visitors.telegramLink(auth()));
        case "GET /visitor/replay":
          return send(200, { items: visitors.replay(auth()) });
        default:
          return send(404, { error: "Not found." });
      }
    } catch (e) {
      if (e instanceof VisitorError) return send(e.status, { error: e.message });
      log(`visitor api error: ${(e as Error).stack ?? e}`);
      return send(500, { error: "Something went wrong. Please try again." });
    }
  });
  server.listen(port, "127.0.0.1", () => log(`visitor api on 127.0.0.1:${port}`));
  return server;
}

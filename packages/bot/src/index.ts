/**
 * Owner channel. Warden uses it for escalations the policy calls for, pause
 * alerts and the daily digest — never for step-by-step confirmations.
 */

export interface Button {
  text: string;
  /** ≤ 64 bytes (Telegram limit). */
  data: string;
}

export type OwnerInput =
  | { kind: "text"; text: string; replyToMessageId?: number }
  | { kind: "button"; data: string; messageId?: number };

/** A reply to someone else's chat (a visitor trying Warden in shadow mode). */
export type VisitorReply = string | { text: string; buttons?: Button[][] } | void;
/** Handles input from any chat that isn't the owner's. Visitors never steer the real vault. */
export type VisitorHandler = (chatId: string, input: OwnerInput) => Promise<VisitorReply>;

export interface OwnerChannel {
  send(text: string, buttons?: Button[][]): Promise<number | undefined>;
  /** Starts delivering owner input; resolves when stopped. */
  listen(onInput: (input: OwnerInput) => Promise<string | void>): Promise<void>;
  stop(): void;
}

interface TgUpdate {
  update_id: number;
  message?: { message_id: number; chat: { id: number }; text?: string; reply_to_message?: { message_id: number } };
  callback_query?: { id: string; data?: string; message?: { message_id: number; chat: { id: number } } };
}

export class TelegramChannel implements OwnerChannel {
  private running = false;
  private offset = 0;

  private onVisitor: VisitorHandler | null = null;

  constructor(
    private readonly token: string,
    private readonly ownerChatId: string,
    private readonly log: (msg: string) => void = console.error,
  ) {}

  /** Routes every non-owner chat to `handler` (shadow-mode visitors). Without it, those chats are ignored. */
  setVisitorHandler(handler: VisitorHandler): void {
    this.onVisitor = handler;
  }

  /** The bot's @username, for t.me deep links. */
  async username(): Promise<string> {
    return (await this.api<{ username: string }>("getMe", {})).username;
  }

  private async api<T>(method: string, body: unknown, timeoutMs = 15_000): Promise<T> {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json()) as { ok: boolean; result: T; description?: string };
    if (!json.ok) throw new Error(`telegram ${method}: ${json.description}`);
    return json.result;
  }

  async send(text: string, buttons?: Button[][]): Promise<number | undefined> {
    return this.sendTo(this.ownerChatId, text, buttons);
  }

  /** Sends to any chat (the owner's, or a linked visitor's). */
  async sendTo(chatId: string, text: string, buttons?: Button[][]): Promise<number | undefined> {
    const msg = await this.api<{ message_id: number }>("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(buttons ? { reply_markup: { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) } } : {}),
    });
    return msg.message_id;
  }

  async listen(onInput: (input: OwnerInput) => Promise<string | void>): Promise<void> {
    this.running = true;
    while (this.running) {
      let updates: TgUpdate[] = [];
      try {
        updates = await this.api<TgUpdate[]>("getUpdates", { offset: this.offset, timeout: 25, allowed_updates: ["message", "callback_query"] }, 35_000);
      } catch (e) {
        this.log(`telegram poll failed: ${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, 5_000));
        continue;
      }
      for (const u of updates) {
        this.offset = u.update_id + 1;
        try {
          await this.handle(u, onInput);
        } catch (e) {
          this.log(`telegram handler failed: ${(e as Error).message}`);
        }
      }
    }
  }

  private async handle(u: TgUpdate, onInput: (input: OwnerInput) => Promise<string | void>): Promise<void> {
    // Only the owner's chat may steer Warden.
    if (u.message && String(u.message.chat.id) === this.ownerChatId && u.message.text) {
      const reply = await onInput({ kind: "text", text: u.message.text, replyToMessageId: u.message.reply_to_message?.message_id });
      if (reply) await this.send(reply);
    } else if (u.callback_query && String(u.callback_query.message?.chat.id) === this.ownerChatId && u.callback_query.data) {
      const reply = await onInput({ kind: "button", data: u.callback_query.data, messageId: u.callback_query.message?.message_id });
      // The callback toast is plain text: strip the HTML the chat message uses.
      await this.api("answerCallbackQuery", { callback_query_id: u.callback_query.id, text: reply ? stripHtml(reply).slice(0, 190) : "OK" });
      if (reply) await this.send(reply);
    } else if (this.onVisitor) {
      await this.handleVisitor(u, this.onVisitor);
    }
  }

  private async handleVisitor(u: TgUpdate, handler: VisitorHandler): Promise<void> {
    if (u.message?.text) {
      const chatId = String(u.message.chat.id);
      await this.reply(chatId, await handler(chatId, { kind: "text", text: u.message.text, replyToMessageId: u.message.reply_to_message?.message_id }));
    } else if (u.callback_query?.data && u.callback_query.message) {
      const chatId = String(u.callback_query.message.chat.id);
      const reply = await handler(chatId, { kind: "button", data: u.callback_query.data, messageId: u.callback_query.message.message_id });
      const text = typeof reply === "string" ? reply : reply?.text;
      await this.api("answerCallbackQuery", { callback_query_id: u.callback_query.id, text: text ? stripHtml(text).slice(0, 190) : "OK" });
      await this.reply(chatId, reply);
    }
  }

  private async reply(chatId: string, reply: VisitorReply): Promise<void> {
    if (!reply) return;
    if (typeof reply === "string") await this.sendTo(chatId, reply);
    else await this.sendTo(chatId, reply.text, reply.buttons);
  }

  stop(): void {
    this.running = false;
  }
}

/** Prints to the console; used when no bot token is configured, and in tests. */
export class ConsoleChannel implements OwnerChannel {
  readonly sent: { text: string; buttons?: Button[][] }[] = [];
  private nextId = 1;

  constructor(private readonly print = true) {}

  async send(text: string, buttons?: Button[][]): Promise<number> {
    this.sent.push({ text, buttons });
    if (this.print) console.log(`\n[owner] ${stripHtml(text)}${buttons ? `\n        ${buttons.flat().map((b) => `[${b.text}]`).join(" ")}` : ""}`);
    return this.nextId++;
  }

  async listen(): Promise<void> {}

  stop(): void {}
}

export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const stripHtml = (s: string) => s.replace(/<[^>]+>/g, "");

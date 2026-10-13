/** Minimal Telegram Bot API client: just what the approval flow needs. */
export class Telegram {
  constructor(
    private token: string,
    readonly chatId: string,
  ) {}

  private async call(method: string, body: Record<string, unknown>): Promise<any> {
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j?.ok) throw new Error(`telegram ${method}: ${j?.description ?? res.status}`);
    return j.result;
  }

  send(html: string) {
    return this.call("sendMessage", { chat_id: this.chatId, text: html, parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  }

  /** Sends a message with Yes/No buttons; returns the Telegram message id. */
  async askApproval(approvalId: number, html: string): Promise<number> {
    const m = await this.call("sendMessage", {
      chat_id: this.chatId,
      text: html,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Yes, place it", callback_data: `a:${approvalId}` },
          { text: "❌ No", callback_data: `r:${approvalId}` },
        ]],
      },
    });
    return m.message_id;
  }

  /** Replaces the message text and removes the buttons, so a decision can't be tapped twice. */
  editMessage(messageId: number, html: string) {
    return this.call("editMessageText", { chat_id: this.chatId, message_id: messageId, text: html, parse_mode: "HTML", reply_markup: { inline_keyboard: [] } });
  }

  answerCallback(callbackId: string, text: string) {
    return this.call("answerCallbackQuery", { callback_query_id: callbackId, text });
  }
}

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

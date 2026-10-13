import type { Alpaca } from "./alpaca.ts";
import type { GuardConfig } from "./guardrails.ts";
import { type ApprovalGate, describeOrder, submitOrder } from "./order-service.ts";
import type { Store } from "./store.ts";
import { esc } from "./telegram.ts";
import { handleCommand, reportTick } from "./telegram-bot.ts";

export interface WebhookDeps {
  alpaca: Alpaca;
  store: Store;
  getCfg: () => Promise<GuardConfig>;
  gate: ApprovalGate;
  /** Must match the secret_token given to Telegram's setWebhook. */
  webhookSecret: string;
}

const safeEqual = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};

/** Scheduler endpoint (pg_cron). Same secret header as the webhook. */
export async function handleReportTick(req: Request, d: WebhookDeps): Promise<Response> {
  const secret = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!d.webhookSecret || !safeEqual(secret, d.webhookSecret)) return new Response("forbidden", { status: 403 });
  try {
    return Response.json(await reportTick({ ...d, telegram: d.gate.telegram }));
  } catch (e) {
    console.error("report tick error", (e as Error).message);
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}

/**
 * Telegram webhook: commands typed in your chat, and Yes/No taps on approval requests. Anything that isn't from Telegram (wrong secret) or isn't a tap by your own chat is ignored.
 * Always answers 200 once authenticated so Telegram doesn't retry; a decision is claimed atomically, so a retry or
 * double tap can never place an order twice.
 */
export async function handleTelegramWebhook(req: Request, d: WebhookDeps): Promise<Response> {
  const secret = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!d.webhookSecret || !safeEqual(secret, d.webhookSecret)) return new Response("forbidden", { status: 403 });

  const update = await req.json().catch(() => null);
  const tg = d.gate.telegram;

  const msg = update?.message;
  if (msg && typeof msg.text === "string") {
    // Only your own private chat with the bot.
    if (String(msg.from?.id) !== tg.chatId || String(msg.chat?.id) !== tg.chatId) return new Response("ok");
    let out: string;
    try {
      out = await handleCommand(msg.text, { ...d, telegram: tg });
    } catch (e) {
      console.error("telegram command error", (e as Error).message);
      out = `⚠️ Error: ${esc((e as Error).message)}`;
    }
    await tg.send(out).catch((e) => console.error("telegram send failed", (e as Error).message));
    return new Response("ok");
  }

  const cb = update?.callback_query;
  const m = /^([ar]):(\d+)$/.exec(cb?.data ?? "");
  if (!cb || !m || String(cb.from?.id) !== tg.chatId || String(cb.message?.chat?.id) !== tg.chatId) {
    return new Response("ok");
  }

  const messageId: number | undefined = cb.message?.message_id;
  const id = Number(m[2]);
  const approve = m[1] === "a";
  const reply = async (toast: string, html?: string) => {
    await Promise.allSettled([tg.answerCallback(cb.id, toast), html && messageId ? tg.editMessage(messageId, html) : undefined]);
  };

  try {
    const row = await d.store.decideApproval(id, approve ? "approved" : "declined");
    if (!row) return await reply("Already handled or expired.").then(() => new Response("ok"));
    const args = {
      symbol: row.symbol,
      side: row.side,
      order_type: row.orderType,
      qty: row.qty ?? undefined,
      notional: row.notional ?? undefined,
      limit_price: row.limitPrice ?? undefined,
      reason: row.reason,
    };
    const what = esc(describeOrder(args));
    if (!approve) {
      await d.store.finishApproval(id, { result: "declined" });
      await reply("Declined.", `❌ <b>Declined #${id}</b>\n${what}`);
      return new Response("ok");
    }
    // Approved: the same guardrails run again against live conditions (market open, cash, caps) before anything is sent.
    const r = await submitOrder(
      { alpaca: d.alpaca, store: d.store, cfg: await d.getCfg(), approval: d.gate },
      { ...args, reason: `${row.reason} [approved via Telegram #${id}]` },
      "mcp",
      { skipApproval: true },
    );
    if (r.ok) {
      await d.store.finishApproval(id, { result: `placed ${r.data.order.id}` });
      await reply("Order placed.", `✅ <b>Placed #${id}</b>\n${what}\n~$${r.data.estimated_notional.toFixed(2)}`);
    } else {
      await d.store.finishApproval(id, { status: "failed", result: r.message });
      await reply("Not placed.", `⚠️ <b>Approved but NOT placed #${id}</b>\n${what}\n${esc(r.message)}`);
    }
  } catch (e) {
    console.error("telegram webhook error", (e as Error).message);
    await d.store.finishApproval(id, { status: "failed", result: (e as Error).message }).catch(() => {});
    await reply("Error, order not placed.", `⚠️ <b>Error on #${id}</b>, order not placed.\n${esc((e as Error).message)}`);
  }
  return new Response("ok");
}

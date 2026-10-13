import { Alpaca, AlpacaError, type Order } from "./alpaca.ts";
import { checkOrder, type GuardConfig } from "./guardrails.ts";
import { DEFAULT_BOT_SETTINGS, nyDate, type Store } from "./store.ts";
import { esc, type Telegram } from "./telegram.ts";

export const num = (s: string | null | undefined) => (s == null ? null : Number(s));

export const slimOrder = (o: Order) => ({
  id: o.id,
  symbol: o.symbol,
  side: o.side,
  type: o.type,
  status: o.status,
  qty: num(o.qty),
  notional: num(o.notional),
  filled_qty: num(o.filled_qty),
  filled_avg_price: num(o.filled_avg_price),
  limit_price: num(o.limit_price),
  submitted_at: o.submitted_at,
  filled_at: o.filled_at,
});

export interface OrderArgs {
  symbol: string; // already normalised to upper case
  side: "buy" | "sell";
  order_type: "market" | "limit";
  qty?: number;
  notional?: number;
  limit_price?: number;
  reason: string;
}

export type OrderOutcome =
  | { ok: true; data: { trade_id: number; orders_today: number; estimated_notional: number; order: ReturnType<typeof slimOrder> } }
  | { ok: false; kind: "guardrail" | "alpaca" | "approval"; message: string };

/** Telegram hookup. Orders from Claude at or above the dashboard's approval % wait for a Yes/No instead of going straight out. */
export interface ApprovalGate {
  telegram: Telegram;
  ttlMinutes: number;
}

const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

export const describeOrder = (a: Pick<OrderArgs, "symbol" | "side" | "order_type" | "qty" | "notional" | "limit_price">) =>
  `${a.side.toUpperCase()} ${a.qty !== undefined ? `${a.qty} ${a.symbol}` : `${usd(a.notional!)} of ${a.symbol}`} (${a.order_type}${a.limit_price ? ` @ ${a.limit_price}` : ""})`;

/**
 * The single path every order takes (Claude via MCP, or you via the dashboard), so the same
 * guardrails and logging apply to both. The daily cap only counts MCP orders (the store
 * does that); manual orders skip it.
 */
export async function submitOrder(
  deps: { alpaca: Alpaca; store: Store; cfg: GuardConfig; approval?: ApprovalGate },
  a: OrderArgs,
  source: "mcp" | "manual",
  opts: { skipApproval?: boolean } = {},
): Promise<OrderOutcome> {
  const { alpaca, store } = deps;
  const cfg: GuardConfig = source === "manual" ? { ...deps.cfg, maxOrdersPerDay: Number.POSITIVE_INFINITY } : deps.cfg;
  const symbol = a.symbol;
  const date = nyDate();
  const base = {
    symbol,
    side: a.side,
    qty: a.qty ?? null,
    notional: a.notional ?? null,
    orderType: a.order_type,
    limitPrice: a.limit_price ?? null,
    source,
    reason: a.reason,
  };

  const [account, clock, positions, openOrders, ordersToday, asset, bot] = await Promise.all([
    alpaca.getAccount(),
    alpaca.getClock(),
    alpaca.getPositions(),
    alpaca.getOrders("open", 200),
    store.countOrdersToday(date),
    alpaca.getAsset(symbol).catch((e) => {
      if (e instanceof AlpacaError && e.status === 404) return null;
      throw e;
    }),
    source === "mcp" ? store.getBotSettings() : Promise.resolve(DEFAULT_BOT_SETTINGS),
  ]);
  const equity = Number(account.equity);

  const reject = async (rule: string, message: string): Promise<OrderOutcome> => {
    await store.insertTrade(date, { ...base, status: "rejected", equity, error: `${rule}: ${message}` });
    return { ok: false, kind: "guardrail", message: `REJECTED by guardrail ${rule}: ${message}` };
  };

  if (source === "mcp" && bot.claudePaused) {
    return reject("PAUSED", "Oliver has paused Claude's trading (dashboard or /pause in Telegram). No orders until he resumes it.");
  }
  if (!asset) return reject("UNKNOWN_SYMBOL", `${symbol} is not a known Alpaca asset.`);
  if (account.trading_blocked || account.account_blocked) {
    return reject("ACCOUNT_BLOCKED", "Alpaca reports trading is blocked on this account.");
  }

  // Price estimate for sizing/guardrails.
  let price: number | null = a.limit_price ?? null;
  if (price === null && a.qty !== undefined) {
    const s = (await alpaca.getSnapshots([symbol]))[symbol];
    price = (a.side === "buy" ? s?.latestQuote?.ap : s?.latestQuote?.bp) || s?.latestTrade?.p || null;
  }

  const pos = positions.find((p) => p.symbol === symbol);
  const openBuyCommitted = openOrders
    .filter((o) => o.side === "buy")
    .reduce((sum, o) => sum + (num(o.notional) ?? (num(o.qty) ?? 0) * (num(o.limit_price) ?? 0)), 0);
  const openSellQty = openOrders
    .filter((o) => o.side === "sell" && o.symbol === symbol)
    .reduce((sum, o) => sum + (num(o.qty) ?? 0) - (num(o.filled_qty) ?? 0), 0);

  const verdict = checkOrder(
    { symbol, side: a.side, orderType: a.order_type, qty: a.qty, notional: a.notional, limitPrice: a.limit_price },
    {
      marketOpen: clock.is_open,
      asset,
      price,
      equity,
      cash: Number(account.cash),
      openBuyCommitted,
      openSellQty,
      position: pos ? { qty: Number(pos.qty), marketValue: Number(pos.market_value) } : null,
      ordersToday,
    },
    cfg,
  );
  if (!verdict.ok) return reject(verdict.rule, verdict.message);

  // Big orders from Claude wait for a Telegram Yes/No. Only orders that passed every guardrail get this far,
  // and the guardrails run again if you approve. If Telegram can't be reached, the order is NOT placed.
  const gate = deps.approval;
  if (gate && source === "mcp" && !opts.skipApproval && bot.approvalPct > 0 && equity > 0 && (verdict.notional / equity) * 100 >= bot.approvalPct) {
    const expiresAt = new Date(Date.now() + gate.ttlMinutes * 60_000).toISOString();
    const pct = (verdict.notional / equity) * 100;
    const id = await store.createApproval({
      symbol, side: a.side, orderType: a.order_type, qty: a.qty ?? null, notional: a.notional ?? null,
      limitPrice: a.limit_price ?? null, reason: a.reason, estNotional: verdict.notional, equity, expiresAt,
    });
    try {
      await gate.telegram.askApproval(
        id,
        `<b>Trade approval #${id}</b>\n${esc(describeOrder({ ...a, symbol }))}\n~${usd(verdict.notional)} (${pct.toFixed(1)}% of ${usd(equity)} equity)\n\n<b>Why:</b> ${esc(a.reason)}\n\nExpires in ${gate.ttlMinutes} min.`,
      );
    } catch (e) {
      await store.finishApproval(id, { status: "failed", result: `telegram: ${(e as Error).message}` });
      return { ok: false, kind: "approval", message: `NOT PLACED: this order needs your approval but the Telegram message could not be sent (${(e as Error).message}). Do not retry; mention it in your note.` };
    }
    return {
      ok: false,
      kind: "approval",
      message: `PENDING APPROVAL (#${id}): ${describeOrder({ ...a, symbol })}, ~${usd(verdict.notional)} (${pct.toFixed(1)}% of equity), was sent to Oliver on Telegram. It is NOT placed yet and only goes out if he taps Yes within ${gate.ttlMinutes} minutes. Do not resubmit it. Record it as pending in your note.`,
    };
  }

  // Reserve the daily slot before talking to Alpaca, so concurrent calls count.
  const tradeId = await store.insertTrade(date, { ...base, status: "pending", equity });
  try {
    const order = await alpaca.placeOrder({
      symbol,
      side: a.side,
      type: a.order_type,
      time_in_force: "day",
      ...(a.qty !== undefined ? { qty: String(a.qty) } : { notional: String(a.notional) }),
      ...(a.order_type === "limit" ? { limit_price: String(a.limit_price) } : {}),
    });
    await store.finishTrade(tradeId, { status: "accepted", alpacaOrderId: order.id });
    // Heads-up when Claude trades on its own (an order you approved already got its own reply).
    if (gate && source === "mcp" && !opts.skipApproval && bot.notifyClaudeTrades) {
      await gate.telegram
        .send(`🤖 <b>Claude: ${esc(describeOrder({ ...a, symbol }))}</b>\n~${usd(verdict.notional)} (${((verdict.notional / equity) * 100).toFixed(1)}% of equity)\n\n<b>Why:</b> ${esc(a.reason)}`)
        .catch((e) => console.error("telegram notify failed", (e as Error).message));
    }
    return {
      ok: true,
      data: { trade_id: tradeId, orders_today: ordersToday + (source === "mcp" ? 1 : 0), estimated_notional: verdict.notional, order: slimOrder(order) },
    };
  } catch (e) {
    const msg = (e as Error).message;
    await store.finishTrade(tradeId, { status: "failed", error: msg });
    return { ok: false, kind: "alpaca", message: `Alpaca rejected the order: ${msg}` };
  }
}

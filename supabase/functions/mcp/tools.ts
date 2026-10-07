import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Alpaca, AlpacaError, type Order } from "./alpaca.ts";
import { checkOrder, type GuardConfig } from "./guardrails.ts";
import { nyDate, type Store } from "./store.ts";

const text = (v: unknown, isError = false) => ({
  content: [{ type: "text" as const, text: typeof v === "string" ? v : JSON.stringify(v, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

const symbolSchema = z.string().regex(/^[A-Za-z]{1,5}(\.[A-Za-z])?$/, "Expected a US ticker like AAPL or BRK.B");
const sym = (s: string) => s.trim().toUpperCase();
const num = (s: string | null | undefined) => (s == null ? null : Number(s));

const slimOrder = (o: Order) => ({
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

export interface ToolDeps {
  alpaca: Alpaca;
  store: Store;
  cfg: GuardConfig;
}

export function createServer({ alpaca, store, cfg }: ToolDeps) {
  const server = new McpServer({ name: "portfolio-mcp", version: "0.2.0" });
  const readOnly = { readOnlyHint: true, openWorldHint: true };

  server.registerTool(
    "get_account",
    {
      title: "Get account",
      description:
        "Alpaca PAPER account summary: equity, cash, buying power, and today's P&L (equity minus last close's equity). Call this first each session. Side effect: the first call on each US calendar date also stores an equity/cash/SPY snapshot used for benchmarking against SPY.",
      inputSchema: {},
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    async () => {
      const a = await alpaca.getAccount();
      const equity = Number(a.equity);
      const cash = Number(a.cash);
      try {
        const snap = await alpaca.getSnapshots(["SPY"]);
        const spy = snap.SPY?.latestTrade?.p ?? snap.SPY?.dailyBar?.c ?? null;
        await store.recordSnapshotIfFirstToday(nyDate(), equity, cash, spy);
      } catch (e) {
        console.error("snapshot failed", (e as Error).message);
      }
      const last = Number(a.last_equity);
      return text({
        equity,
        cash,
        buying_power: Number(a.buying_power),
        portfolio_value: Number(a.portfolio_value),
        last_equity: last,
        day_pl: equity - last,
        day_pl_pct: last ? ((equity - last) / last) * 100 : null,
        status: a.status,
        trading_blocked: a.trading_blocked ?? false,
      });
    },
  );

  server.registerTool(
    "get_positions",
    {
      title: "Get positions",
      description: "All open positions with quantity, average entry, market value, current price and unrealized P&L (absolute and percent).",
      inputSchema: {},
      annotations: readOnly,
    },
    async () => {
      const ps = await alpaca.getPositions();
      return text(
        ps.map((p) => ({
          symbol: p.symbol,
          side: p.side,
          qty: Number(p.qty),
          avg_entry_price: Number(p.avg_entry_price),
          current_price: Number(p.current_price),
          market_value: Number(p.market_value),
          unrealized_pl: Number(p.unrealized_pl),
          unrealized_pl_pct: Number(p.unrealized_plpc) * 100,
          unrealized_intraday_pl: Number(p.unrealized_intraday_pl),
        })),
      );
    },
  );

  server.registerTool(
    "get_quotes",
    {
      title: "Get quotes",
      description:
        "Latest trade, bid/ask and today's bar (plus previous close) for up to 25 symbols. IEX feed, so volume is a fraction of consolidated volume.",
      inputSchema: { symbols: z.array(symbolSchema).min(1).max(25) },
      annotations: readOnly,
    },
    async ({ symbols }) => {
      const list = symbols.map(sym);
      const snaps = await alpaca.getSnapshots(list);
      return text(
        list.map((s) => {
          const x = snaps[s];
          if (!x) return { symbol: s, error: "no data" };
          return {
            symbol: s,
            last: x.latestTrade?.p ?? null,
            bid: x.latestQuote?.bp ?? null,
            ask: x.latestQuote?.ap ?? null,
            today: x.dailyBar ?? null,
            prev_close: x.prevDailyBar?.c ?? null,
            as_of: x.latestTrade?.t ?? null,
          };
        }),
      );
    },
  );

  server.registerTool(
    "get_bars",
    {
      title: "Get daily bars",
      description: "Historical split-adjusted daily OHLCV bars for one symbol, oldest first. lookback_days is the number of trading days (1-250).",
      inputSchema: { symbol: symbolSchema, lookback_days: z.number().int().min(1).max(250).default(30) },
      annotations: readOnly,
    },
    async ({ symbol, lookback_days }) => text(await alpaca.getDailyBars(sym(symbol), lookback_days)),
  );

  server.registerTool(
    "get_market_clock",
    {
      title: "Get market clock",
      description: "Whether the US equity market is open right now, plus the next open and next close timestamps.",
      inputSchema: {},
      annotations: readOnly,
    },
    async () => text(await alpaca.getClock()),
  );

  server.registerTool(
    "get_orders",
    {
      title: "Get orders",
      description: "Orders from Alpaca, newest first. status: 'open' (working orders), 'closed' (filled/canceled/expired), or 'all'. Default returns all, limit 50.",
      inputSchema: {
        status: z.enum(["open", "closed", "all"]).default("all"),
        limit: z.number().int().min(1).max(200).default(50),
      },
      annotations: readOnly,
    },
    async ({ status, limit }) => text((await alpaca.getOrders(status, limit)).map(slimOrder)),
  );

  server.registerTool(
    "place_order",
    {
      title: "Place order",
      description:
        "Place a PAPER order for a US equity/ETF (long-only, day orders). Provide exactly one of qty (shares, fractional allowed for market orders) or notional (dollars, market orders only). Limit orders need qty and limit_price. A non-empty 'reason' (why you are making this trade) is REQUIRED and is logged. Server-side guardrails reject: market closed, short selling, margin/insufficient cash, order > 10% of equity (buys), position > 20% of equity after the order, more than 10 orders per day, non-equity assets. A rejection message names the rule that fired; do not retry the same order unchanged.",
      inputSchema: {
        symbol: symbolSchema,
        side: z.enum(["buy", "sell"]),
        order_type: z.enum(["market", "limit"]).default("market"),
        qty: z.number().positive().optional(),
        notional: z.number().positive().optional(),
        limit_price: z.number().positive().optional(),
        reason: z.string().trim().min(10, "reason must explain the trade (min 10 chars)").max(2000),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (a) => {
      const symbol = sym(a.symbol);
      const date = nyDate();
      const base = {
        symbol,
        side: a.side,
        qty: a.qty ?? null,
        notional: a.notional ?? null,
        orderType: a.order_type,
        limitPrice: a.limit_price ?? null,
        reason: a.reason,
      };

      const [account, clock, positions, openOrders, ordersToday, asset] = await Promise.all([
        alpaca.getAccount(),
        alpaca.getClock(),
        alpaca.getPositions(),
        alpaca.getOrders("open", 200),
        store.countOrdersToday(date),
        alpaca.getAsset(symbol).catch((e) => {
          if (e instanceof AlpacaError && e.status === 404) return null;
          throw e;
        }),
      ]);
      const equity = Number(account.equity);

      const reject = async (rule: string, message: string) => {
        await store.insertTrade(date, { ...base, status: "rejected", equity, error: `${rule}: ${message}` });
        return text(`REJECTED by guardrail ${rule}: ${message}`, true);
      };

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
        return text({ trade_id: tradeId, orders_today: ordersToday + 1, estimated_notional: verdict.notional, order: slimOrder(order) });
      } catch (e) {
        const msg = (e as Error).message;
        await store.finishTrade(tradeId, { status: "failed", error: msg });
        return text(`Alpaca rejected the order: ${msg}`, true);
      }
    },
  );

  server.registerTool(
    "cancel_order",
    {
      title: "Cancel order",
      description: "Cancel an open order by its Alpaca order ID (from get_orders or place_order).",
      inputSchema: { order_id: z.string().uuid() },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ order_id }) => {
      try {
        await alpaca.cancelOrder(order_id);
        await store.markCanceled(order_id).catch(() => {});
        return text({ canceled: order_id });
      } catch (e) {
        return text((e as Error).message, true);
      }
    },
  );

  server.registerTool(
    "get_trade_log",
    {
      title: "Get trade log",
      description:
        "Past trading decisions from the server's own log, newest first: symbol, side, size, status (accepted/failed/rejected by guardrail), the reason you gave, and equity at the time. Use it to review earlier reasoning before acting.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).default(30),
        symbol: symbolSchema.optional(),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ limit, symbol }) => text(await store.listTrades(limit, symbol ? sym(symbol) : undefined)),
  );

  return server;
}

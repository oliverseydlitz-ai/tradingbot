import { z } from "zod";
import type { Alpaca } from "./alpaca.ts";
import { categorize } from "./categorize.ts";
import { type GuardConfig, validateSettings } from "./guardrails.ts";
import { slimOrder, submitOrder } from "./order-service.ts";
import { nyDate, type Store } from "./store.ts";

export interface ApiDeps {
  alpaca: Alpaca;
  store: Store;
  getCfg: () => Promise<GuardConfig>;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const symbolRe = /^[A-Za-z]{1,5}(\.[A-Za-z])?$/;
const orderBody = z.object({
  symbol: z.string().regex(symbolRe),
  side: z.enum(["buy", "sell"]),
  order_type: z.enum(["market", "limit"]).default("market"),
  qty: z.number().positive().optional(),
  notional: z.number().positive().optional(),
  limit_price: z.number().positive().optional(),
  note: z.string().trim().max(500).optional(),
});
const cancelBody = z.object({ order_id: z.string().uuid() });

const PERIOD_BARS: Record<string, number> = { "1W": 10, "1M": 25, "3M": 66, "6M": 130, "1A": 250, all: 250 };

const settingsOut = (c: GuardConfig) => ({
  maxOrderPct: c.maxOrderPct,
  maxPositionPct: c.maxPositionPct,
  maxOrdersPerDay: c.maxOrdersPerDay,
  allowlist: c.allowlist,
});

/** Dashboard API. The caller has already authenticated the request as the allowlisted user. */
export function createApi({ alpaca, store, getCfg }: ApiDeps) {
  return async function handle(req: Request, route: string): Promise<Response> {
    const url = new URL(req.url);
    const m = req.method;

    if (route === "/portfolio" && m === "GET") {
      const [account, positions, clock, openOrders, recent, cfg, mcpToday] = await Promise.all([
        alpaca.getAccount(),
        alpaca.getPositions(),
        alpaca.getClock(),
        alpaca.getOrders("open", 100),
        alpaca.getOrders("closed", 20),
        getCfg(),
        store.countOrdersToday(nyDate()),
      ]);
      const assets = await Promise.all(positions.map((p) => alpaca.getAsset(p.symbol).catch(() => null)));
      const equity = Number(account.equity);
      const cash = Number(account.cash);
      const rows = positions.map((p, i) => {
        const mv = Number(p.market_value);
        return {
          symbol: p.symbol,
          name: assets[i]?.name ?? p.symbol,
          category: categorize(assets[i]?.name),
          qty: Number(p.qty),
          avg_entry_price: Number(p.avg_entry_price),
          current_price: Number(p.current_price),
          market_value: mv,
          weight_pct: equity ? (mv / equity) * 100 : 0,
          unrealized_pl: Number(p.unrealized_pl),
          unrealized_pl_pct: Number(p.unrealized_plpc) * 100,
          day_pl: Number(p.unrealized_intraday_pl),
          day_pl_pct: Number(p.unrealized_intraday_plpc ?? 0) * 100,
        };
      });
      const alloc: Record<string, number> = { Stock: 0, ETF: 0, "Bond ETF": 0 };
      for (const r of rows) alloc[r.category] += r.market_value;
      const byPct = [...rows].sort((a, b) => b.unrealized_pl_pct - a.unrealized_pl_pct);
      const bestN = Math.min(5, Math.ceil(byPct.length / 2)); // best and worst never overlap
      const last = Number(account.last_equity);
      return json({
        account: {
          equity,
          cash,
          last_equity: last,
          day_pl: equity - last,
          day_pl_pct: last ? ((equity - last) / last) * 100 : 0,
          status: account.status,
        },
        positions: rows,
        allocation: [
          { label: "Stocks", value: alloc.Stock },
          { label: "ETFs", value: alloc.ETF },
          { label: "Bond ETFs", value: alloc["Bond ETF"] },
          { label: "Cash", value: cash },
        ],
        performers: { best: byPct.slice(0, bestN), worst: byPct.slice(bestN).slice(-5).reverse() },
        market: { is_open: clock.is_open, next_open: clock.next_open, next_close: clock.next_close },
        open_orders: openOrders.map(slimOrder),
        recent_orders: recent.map(slimOrder),
        settings: settingsOut(cfg),
        usage: { mcp_orders_today: mcpToday },
      });
    }

    if (route === "/history" && m === "GET") {
      const period = url.searchParams.get("period") ?? "1M";
      if (!(period in PERIOD_BARS)) return json({ error: "bad period" }, 400);
      const [hist, bars] = await Promise.all([alpaca.getPortfolioHistory(period), alpaca.getDailyBars("SPY", PERIOD_BARS[period])]);
      const spy = new Map(bars.map((b) => [b.date, b.c as number]));
      const rows = hist.timestamp
        .map((t, i) => ({ date: nyDate(new Date(t * 1000)), equity: hist.equity[i] }))
        .filter((r): r is { date: string; equity: number } => !!r.equity && r.equity > 0 && spy.has(r.date));
      if (!rows.length) return json({ points: [] });
      const e0 = rows[0].equity;
      const s0 = spy.get(rows[0].date)!;
      return json({
        points: rows.map((r) => ({
          date: r.date,
          equity: r.equity,
          portfolio: (r.equity / e0) * 100,
          spy: (spy.get(r.date)! / s0) * 100,
        })),
      });
    }

    if (route === "/trades" && m === "GET") {
      const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 30) || 30, 1), 200);
      return json({ trades: await store.listTrades(limit) });
    }

    if (route === "/quote" && m === "GET") {
      const symbol = (url.searchParams.get("symbol") ?? "").trim().toUpperCase();
      if (!symbolRe.test(symbol)) return json({ error: "bad symbol" }, 400);
      const [snaps, asset] = await Promise.all([alpaca.getSnapshots([symbol]), alpaca.getAsset(symbol).catch(() => null)]);
      const s = snaps[symbol];
      if (!asset) return json({ error: `${symbol} is not a known asset` }, 404);
      return json({
        symbol,
        name: asset.name,
        category: categorize(asset.name),
        tradable: asset.tradable && asset.class === "us_equity",
        fractionable: asset.fractionable,
        last: s?.latestTrade?.p ?? null,
        bid: s?.latestQuote?.bp ?? null,
        ask: s?.latestQuote?.ap ?? null,
        prev_close: s?.prevDailyBar?.c ?? null,
      });
    }

    if (route === "/order" && m === "POST") {
      const parsed = orderBody.safeParse(await req.json().catch(() => null));
      if (!parsed.success) return json({ ok: false, message: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
      const b = parsed.data;
      const r = await submitOrder(
        { alpaca, store, cfg: await getCfg() },
        {
          symbol: b.symbol.toUpperCase(),
          side: b.side,
          order_type: b.order_type,
          qty: b.qty,
          notional: b.notional,
          limit_price: b.limit_price,
          reason: b.note || "Manual trade from dashboard",
        },
        "manual",
      );
      return r.ok ? json({ ok: true, ...r.data }) : json({ ok: false, message: r.message }, r.kind === "guardrail" ? 422 : 502);
    }

    if (route === "/cancel" && m === "POST") {
      const parsed = cancelBody.safeParse(await req.json().catch(() => null));
      if (!parsed.success) return json({ ok: false, message: "order_id must be a UUID" }, 400);
      try {
        await alpaca.cancelOrder(parsed.data.order_id);
        await store.markCanceled(parsed.data.order_id).catch(() => {});
        return json({ ok: true });
      } catch (e) {
        return json({ ok: false, message: (e as Error).message }, 502);
      }
    }

    if (route === "/settings" && m === "GET") return json({ settings: settingsOut(await getCfg()) });

    if (route === "/settings" && m === "PUT") {
      const v = validateSettings(await req.json().catch(() => null));
      if (!v.ok) return json({ ok: false, message: v.error }, 400);
      await store.saveSettings(v.cfg);
      return json({ ok: true, settings: settingsOut(v.cfg) });
    }

    return json({ error: "not found" }, 404);
  };
}

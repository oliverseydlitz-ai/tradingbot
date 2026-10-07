import type { Asset } from "./alpaca";

export interface GuardConfig {
  maxOrderPct: number;
  maxPositionPct: number;
  maxOrdersPerDay: number;
  allowlist: string[]; // empty = any tradable US equity
}

export interface OrderRequest {
  symbol: string;
  side: "buy" | "sell";
  orderType: "market" | "limit";
  qty?: number;
  notional?: number;
  limitPrice?: number;
}

export interface GuardContext {
  marketOpen: boolean;
  asset: Asset;
  /** Per-share price estimate: limit price, else latest ask (buys) / bid (sells). */
  price: number | null;
  equity: number;
  cash: number;
  /** Cash already earmarked by open buy orders. */
  openBuyCommitted: number;
  /** Shares already earmarked by open sell orders for this symbol. */
  openSellQty: number;
  position: { qty: number; marketValue: number } | null;
  ordersToday: number;
}

export type GuardResult =
  | { ok: true; notional: number }
  | { ok: false; rule: string; message: string };

const fail = (rule: string, message: string): GuardResult => ({ ok: false, rule, message });
const usd = (n: number) => `$${n.toFixed(2)}`;

export function parseConfig(env: {
  MAX_ORDER_PCT: string;
  MAX_POSITION_PCT: string;
  MAX_ORDERS_PER_DAY: string;
  SYMBOL_ALLOWLIST: string;
}): GuardConfig {
  const num = (v: string, name: string) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid ${name}: ${v}`);
    return n;
  };
  return {
    maxOrderPct: num(env.MAX_ORDER_PCT, "MAX_ORDER_PCT"),
    maxPositionPct: num(env.MAX_POSITION_PCT, "MAX_POSITION_PCT"),
    maxOrdersPerDay: num(env.MAX_ORDERS_PER_DAY, "MAX_ORDERS_PER_DAY"),
    allowlist: env.SYMBOL_ALLOWLIST.split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  };
}

/** Pure rule engine for place_order. Every rejection names the rule that fired. */
export function checkOrder(req: OrderRequest, ctx: GuardContext, cfg: GuardConfig): GuardResult {
  // 1. Market must be open.
  if (!ctx.marketOpen) {
    return fail("MARKET_CLOSED", "Market is closed. Orders are only accepted during regular trading hours.");
  }

  // 2. Long-only US equities/ETFs. Asset class check excludes crypto and options.
  if (ctx.asset.class !== "us_equity") {
    return fail("ASSET_CLASS", `${req.symbol} is class '${ctx.asset.class}'; only US equities and ETFs are allowed (no options, no crypto).`);
  }
  if (ctx.asset.status !== "active" || !ctx.asset.tradable) {
    return fail("NOT_TRADABLE", `${req.symbol} is not currently tradable.`);
  }
  if (cfg.allowlist.length && !cfg.allowlist.includes(req.symbol)) {
    return fail("SYMBOL_ALLOWLIST", `${req.symbol} is not in the symbol allowlist (${cfg.allowlist.join(", ")}).`);
  }

  // Sizing inputs.
  if ((req.qty === undefined) === (req.notional === undefined)) {
    return fail("SIZE_INPUT", "Provide exactly one of qty or notional.");
  }
  if (req.orderType === "limit" && (req.limitPrice === undefined || req.limitPrice <= 0)) {
    return fail("LIMIT_PRICE", "Limit orders require a positive limit_price.");
  }
  if (req.orderType === "limit" && req.notional !== undefined) {
    return fail("SIZE_INPUT", "Limit orders must be sized with qty, not notional.");
  }
  if (req.qty !== undefined && !(req.qty > 0)) return fail("SIZE_INPUT", "qty must be positive.");
  if (req.notional !== undefined && !(req.notional >= 1)) return fail("SIZE_INPUT", "notional must be at least $1.");
  if ((req.notional !== undefined || !Number.isInteger(req.qty)) && !ctx.asset.fractionable) {
    return fail("NOT_FRACTIONABLE", `${req.symbol} is not fractionable; use a whole-number qty.`);
  }

  let notional: number;
  if (req.notional !== undefined) {
    notional = req.notional;
  } else {
    if (ctx.price === null || !(ctx.price > 0)) {
      return fail("NO_PRICE", `Could not determine a price for ${req.symbol}; cannot size the order.`);
    }
    notional = req.qty! * ctx.price;
  }

  if (req.side === "sell") {
    // 3. No shorting: can only sell what's held and not already earmarked.
    if (!ctx.position || ctx.position.qty <= 0) {
      return fail("NO_SHORTING", `No long position in ${req.symbol}; short selling is not allowed.`);
    }
    const available = ctx.position.qty - ctx.openSellQty;
    if (req.qty !== undefined && req.qty > available + 1e-9) {
      return fail("NO_SHORTING", `Sell qty ${req.qty} exceeds available long qty ${available} of ${req.symbol} (held ${ctx.position.qty}, ${ctx.openSellQty} already in open sell orders).`);
    }
    if (req.notional !== undefined && req.notional > ctx.position.marketValue * (available / ctx.position.qty) + 0.01) {
      return fail("NO_SHORTING", `Sell notional ${usd(req.notional)} exceeds the available value of your ${req.symbol} position.`);
    }
  } else {
    // 4. No margin: buys must be covered by settled cash net of other open buys.
    const spendable = ctx.cash - ctx.openBuyCommitted;
    if (notional > spendable + 0.01) {
      return fail("NO_MARGIN", `Order ~${usd(notional)} exceeds spendable cash ${usd(spendable)} (cash ${usd(ctx.cash)} minus ${usd(ctx.openBuyCommitted)} in open buy orders). Margin is not allowed.`);
    }
    // 5. Max single order notional (buys; sells reduce risk and are never blocked by size).
    const maxOrder = (ctx.equity * cfg.maxOrderPct) / 100;
    if (notional > maxOrder + 0.01) {
      return fail("MAX_ORDER_PCT", `Order ~${usd(notional)} exceeds ${cfg.maxOrderPct}% of equity (${usd(maxOrder)} of ${usd(ctx.equity)}).`);
    }
    // 6. Max position size after the order.
    const after = (ctx.position?.marketValue ?? 0) + notional;
    const maxPos = (ctx.equity * cfg.maxPositionPct) / 100;
    if (after > maxPos + 0.01) {
      return fail("MAX_POSITION_PCT", `Position in ${req.symbol} would be ~${usd(after)} after this order, exceeding ${cfg.maxPositionPct}% of equity (${usd(maxPos)}).`);
    }
  }

  // 7. Daily order cap.
  if (ctx.ordersToday >= cfg.maxOrdersPerDay) {
    return fail("MAX_ORDERS_PER_DAY", `Daily order limit reached (${ctx.ordersToday}/${cfg.maxOrdersPerDay}). No more orders today.`);
  }

  return { ok: true, notional };
}

import { describe, expect, it } from "vitest";
import type { Asset } from "../supabase/functions/mcp/alpaca.ts";
import { checkOrder, parseConfig, type GuardContext } from "../supabase/functions/mcp/guardrails.ts";

const cfg = parseConfig({ MAX_ORDER_PCT: "10", MAX_POSITION_PCT: "20", MAX_ORDERS_PER_DAY: "10", SYMBOL_ALLOWLIST: "" });
const asset: Asset = { symbol: "SPY", class: "us_equity", status: "active", tradable: true, fractionable: true, shortable: true, exchange: "ARCA", name: "SPDR" };
const ctx = (o: Partial<GuardContext> = {}): GuardContext => ({
  marketOpen: true, asset, price: 100, equity: 100_000, cash: 100_000, openBuyCommitted: 0, openSellQty: 0, position: null, ordersToday: 0, ...o,
});
const buy = (qty: number) => ({ symbol: "SPY", side: "buy" as const, orderType: "market" as const, qty });
const rule = (r: ReturnType<typeof checkOrder>) => (r.ok ? "OK" : r.rule);

describe("guardrails", () => {
  it("accepts a normal buy", () => expect(rule(checkOrder(buy(50), ctx(), cfg))).toBe("OK"));
  it("rejects when market closed", () => expect(rule(checkOrder(buy(1), ctx({ marketOpen: false }), cfg))).toBe("MARKET_CLOSED"));
  it("rejects order over 10% of equity", () => expect(rule(checkOrder(buy(101), ctx(), cfg))).toBe("MAX_ORDER_PCT"));
  it("allows exactly 10%", () => expect(rule(checkOrder(buy(100), ctx(), cfg))).toBe("OK"));
  it("rejects position over 20% after the order", () =>
    expect(rule(checkOrder(buy(50), ctx({ position: { qty: 160, marketValue: 16_000 } }), cfg))).toBe("MAX_POSITION_PCT"));
  it("rejects the 11th order of the day", () => expect(rule(checkOrder(buy(1), ctx({ ordersToday: 10 }), cfg))).toBe("MAX_ORDERS_PER_DAY"));
  it("allows the 10th order", () => expect(rule(checkOrder(buy(1), ctx({ ordersToday: 9 }), cfg))).toBe("OK"));
  it("rejects shorting with no position", () =>
    expect(rule(checkOrder({ ...buy(1), side: "sell" }, ctx(), cfg))).toBe("NO_SHORTING"));
  it("rejects selling more than held", () =>
    expect(rule(checkOrder({ ...buy(11), side: "sell" }, ctx({ position: { qty: 10, marketValue: 1000 } }), cfg))).toBe("NO_SHORTING"));
  it("rejects selling shares already in open sell orders", () =>
    expect(rule(checkOrder({ ...buy(6), side: "sell" }, ctx({ position: { qty: 10, marketValue: 1000 }, openSellQty: 5 }), cfg))).toBe("NO_SHORTING"));
  it("lets you sell a whole oversize position (risk-reducing)", () =>
    expect(rule(checkOrder({ ...buy(200), side: "sell" }, ctx({ position: { qty: 200, marketValue: 20_000 } }), cfg))).toBe("OK"));
  it("rejects margin (buy beyond cash)", () => expect(rule(checkOrder(buy(50), ctx({ cash: 1000 }), cfg))).toBe("NO_MARGIN"));
  it("counts open buy orders against cash", () =>
    expect(rule(checkOrder(buy(50), ctx({ cash: 6000, openBuyCommitted: 2000 }), cfg))).toBe("NO_MARGIN"));
  it("rejects crypto / non-equity", () =>
    expect(rule(checkOrder(buy(1), ctx({ asset: { ...asset, class: "crypto" } }), cfg))).toBe("ASSET_CLASS"));
  it("enforces the symbol allowlist", () =>
    expect(rule(checkOrder(buy(1), ctx(), { ...cfg, allowlist: ["QQQ"] }))).toBe("SYMBOL_ALLOWLIST"));
  it("requires exactly one of qty/notional", () =>
    expect(rule(checkOrder({ ...buy(1), notional: 100 }, ctx(), cfg))).toBe("SIZE_INPUT"));
  it("limit orders need a limit price", () =>
    expect(rule(checkOrder({ ...buy(1), orderType: "limit" }, ctx(), cfg))).toBe("LIMIT_PRICE"));
  it("rejects fractional qty on non-fractionable assets", () =>
    expect(rule(checkOrder(buy(1.5), ctx({ asset: { ...asset, fractionable: false } }), cfg))).toBe("NOT_FRACTIONABLE"));
});

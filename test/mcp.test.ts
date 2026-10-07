import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Alpaca } from "../supabase/functions/mcp/alpaca.ts";
import { createHandler } from "../supabase/functions/mcp/app.ts";
import { allowedGithubLogin } from "../supabase/functions/mcp/auth.ts";
import { parseConfig } from "../supabase/functions/mcp/guardrails.ts";
import { nyDate, type Store, type TradeRow } from "../supabase/functions/mcp/store.ts";

const URL_BASE = "https://ref.supabase.co/functions/v1/mcp";

function memStore() {
  const trades: (TradeRow & { id: number; date: string; alpacaOrderId?: string })[] = [];
  const snapshots: Record<string, unknown> = {};
  const store: Store = {
    countOrdersToday: async (d) => trades.filter((t) => t.date === d && ["pending", "accepted", "canceled"].includes(t.status)).length,
    insertTrade: async (date, t) => (trades.push({ ...t, id: trades.length + 1, date }), trades.length),
    finishTrade: async (id, p) => void Object.assign(trades[id - 1], { status: p.status, alpacaOrderId: p.alpacaOrderId, error: p.error }),
    markCanceled: async (oid) => void trades.filter((t) => t.alpacaOrderId === oid).forEach((t) => ((t as any).status = "canceled")),
    recordSnapshotIfFirstToday: async (d, equity, cash, spy) => void (snapshots[d] ??= { equity, cash, spy }),
    listTrades: async (limit, symbol) => trades.filter((t) => !symbol || t.symbol === symbol).slice().reverse().slice(0, limit),
  };
  return { store, trades, snapshots };
}

const mk = (authenticate = async (t: string) => (t === "good" ? { login: "oliver" } : null)) => {
  const m = memStore();
  const handler = createHandler({
    store: m.store,
    alpaca: new Alpaca({ keyId: "k", secretKey: "s" }),
    cfg: parseConfig({ MAX_ORDER_PCT: "10", MAX_POSITION_PCT: "20", MAX_ORDERS_PER_DAY: "10", SYMBOL_ALLOWLIST: "" }),
    resourceUrl: URL_BASE,
    authServerUrl: "https://ref.supabase.co/auth/v1",
    authenticate,
  });
  return { ...m, handler };
};

// ---- fake Alpaca over global fetch ----
let market = { is_open: true };
const account = { equity: "100000", last_equity: "99000", cash: "100000", buying_power: "100000", portfolio_value: "100000", status: "ACTIVE" };
let positions: any[] = [];
const placed: any[] = [];
function alpacaFetch(input: any, init?: any) {
  const url = new URL(typeof input === "string" ? input : input.url);
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  if (url.hostname === "paper-api.alpaca.markets") {
    const p = url.pathname;
    if (p === "/v2/account") return json(account);
    if (p === "/v2/clock") return json({ ...market, timestamp: "", next_open: "", next_close: "" });
    if (p === "/v2/positions") return json(positions);
    if (p === "/v2/orders" && init?.method === "POST") {
      const body = JSON.parse(init.body);
      placed.push(body);
      return json({ id: crypto.randomUUID(), ...body, status: "accepted", filled_qty: "0", qty: body.qty ?? null, notional: body.notional ?? null, limit_price: body.limit_price ?? null, filled_avg_price: null, created_at: "", submitted_at: "", filled_at: null });
    }
    if (p === "/v2/orders") return json([]);
    if (p.startsWith("/v2/assets/")) {
      const s = p.split("/").pop()!;
      if (s === "NOPE") return json({ message: "asset not found" }, 404);
      return json({ symbol: s, class: s === "BTCUS" ? "crypto" : "us_equity", status: "active", tradable: true, fractionable: true, shortable: true, exchange: "ARCA", name: s });
    }
  }
  if (url.hostname === "data.alpaca.markets" && url.pathname === "/v2/stocks/snapshots") {
    const out: any = {};
    for (const s of url.searchParams.get("symbols")!.split(","))
      out[s] = { latestTrade: { p: 100, t: "" }, latestQuote: { ap: 100, bp: 99.9, as: 1, bs: 1, t: "" }, dailyBar: { o: 1, h: 1, l: 1, c: 100, v: 1, t: "" }, prevDailyBar: { c: 99 } };
    return json(out);
  }
  return json({ message: `unmocked ${url}` }, 500);
}

async function rpc(h: (r: Request) => Promise<Response>, method: string, params: unknown, token = "good") {
  const res = await h(
    new Request(URL_BASE, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  const raw = await res.text();
  const line = raw.split("\n").find((l) => l.startsWith("data:"));
  return { status: res.status, body: JSON.parse(line ? line.slice(5) : raw) };
}
const call = async (h: any, name: string, args: Record<string, unknown>) => {
  const { body } = await rpc(h, "tools/call", { name, arguments: args });
  if (body.error) return { isError: true, text: JSON.stringify(body.error) };
  return { isError: !!body.result.isError, text: body.result.content[0].text as string };
};

describe("auth surface", () => {
  it("401s without a token and points at the protected-resource metadata", async () => {
    const { handler } = mk();
    const res = await handler(new Request(URL_BASE, { method: "POST", body: "{}" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${URL_BASE}/.well-known/oauth-protected-resource"`);
  });
  it("401s with a bad token", async () => {
    const { status } = await rpc(mk().handler, "tools/list", {}, "bad");
    expect(status).toBe(401);
  });
  it("serves protected-resource metadata pointing at Supabase Auth", async () => {
    const res = await mk().handler(new Request(`${URL_BASE}/.well-known/oauth-protected-resource`));
    expect(await res.json()).toMatchObject({ resource: URL_BASE, authorization_servers: ["https://ref.supabase.co/auth/v1"] });
  });
  it("allowlist: only the configured GitHub login passes", () => {
    const u = (name: string) => ({ identities: [{ provider: "github", identity_data: { user_name: name } }] });
    expect(allowedGithubLogin(u("Oliver"), "oliver")).toBe("oliver");
    expect(allowedGithubLogin(u("mallory"), "oliver")).toBeNull();
    expect(allowedGithubLogin({ identities: [{ provider: "google", identity_data: { user_name: "oliver" } }] }, "oliver")).toBeNull();
    expect(allowedGithubLogin({}, "oliver")).toBeNull();
    expect(allowedGithubLogin(u("oliver"), "")).toBeNull();
  });
});

describe("tools (mocked Alpaca + in-memory store)", () => {
  beforeAll(() => void vi.stubGlobal("fetch", vi.fn(alpacaFetch)));
  afterEach(() => {
    market = { is_open: true };
    positions = [];
    placed.length = 0;
  });

  it("lists all nine tools", async () => {
    const { body } = await rpc(mk().handler, "tools/list", {});
    expect(body.result.tools.map((t: any) => t.name).sort()).toEqual(
      ["cancel_order", "get_account", "get_bars", "get_market_clock", "get_orders", "get_positions", "get_quotes", "get_trade_log", "place_order"],
    );
  });

  it("get_account stores one snapshot per day", async () => {
    const { handler, snapshots } = mk();
    const r = await call(handler, "get_account", {});
    expect(JSON.parse(r.text).equity).toBe(100000);
    await call(handler, "get_account", {});
    expect(snapshots[nyDate()]).toMatchObject({ equity: 100000, spy: 100 });
  });

  it("places an order and logs it with reason + equity", async () => {
    const { handler, trades } = mk();
    const r = await call(handler, "place_order", { symbol: "spy", side: "buy", qty: 50, reason: "Core holding to match benchmark" });
    expect(r.isError).toBe(false);
    expect(placed[0]).toMatchObject({ symbol: "SPY", side: "buy", qty: "50", type: "market", time_in_force: "day" });
    expect(trades[0]).toMatchObject({ status: "accepted", reason: "Core holding to match benchmark", equity: 100000 });
    expect(trades[0].alpacaOrderId).toBeTruthy();
  });

  it("rejects closed market, oversize, short, crypto, unknown, missing reason", async () => {
    const { handler, trades } = mk();
    market = { is_open: false };
    expect((await call(handler, "place_order", { symbol: "SPY", side: "buy", qty: 1, reason: "market is closed test" })).text).toMatch(/MARKET_CLOSED/);
    market = { is_open: true };
    expect((await call(handler, "place_order", { symbol: "SPY", side: "buy", qty: 101, reason: "oversize order test" })).text).toMatch(/MAX_ORDER_PCT/);
    expect((await call(handler, "place_order", { symbol: "SPY", side: "sell", qty: 1, reason: "short sell attempt test" })).text).toMatch(/NO_SHORTING/);
    expect((await call(handler, "place_order", { symbol: "BTCUS", side: "buy", qty: 1, reason: "crypto attempt test" })).text).toMatch(/ASSET_CLASS/);
    expect((await call(handler, "place_order", { symbol: "NOPE", side: "buy", qty: 1, reason: "unknown symbol test" })).text).toMatch(/UNKNOWN_SYMBOL/);
    expect((await call(handler, "place_order", { symbol: "SPY", side: "buy", qty: 1, reason: "" })).isError).toBe(true);
    expect(placed).toHaveLength(0);
    expect(trades.filter((t) => t.status === "rejected")).toHaveLength(5); // every guardrail rejection is logged
  });

  it("rejects the 11th order of the day", async () => {
    const { handler } = mk();
    for (let i = 0; i < 10; i++) {
      expect((await call(handler, "place_order", { symbol: "SPY", side: "buy", qty: 1, reason: `order number ${i + 1} of the day` })).isError).toBe(false);
    }
    expect((await call(handler, "place_order", { symbol: "SPY", side: "buy", qty: 1, reason: "the eleventh order" })).text).toMatch(/MAX_ORDERS_PER_DAY/);
    expect(placed).toHaveLength(10);
  });

  it("get_trade_log reads back decisions", async () => {
    const { handler } = mk();
    await call(handler, "place_order", { symbol: "SPY", side: "buy", qty: 1, reason: "log readback test" });
    expect(JSON.parse((await call(handler, "get_trade_log", { limit: 5 })).text)[0].reason).toBe("log readback test");
  });
});

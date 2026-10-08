import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Alpaca } from "../supabase/functions/mcp/alpaca.ts";
import { createHandler } from "../supabase/functions/mcp/app.ts";
import { allowedGithubLogin } from "../supabase/functions/mcp/auth.ts";
import { parseConfig, type GuardConfig } from "../supabase/functions/mcp/guardrails.ts";
import { nyDate, type Store, type TradeRow } from "../supabase/functions/mcp/store.ts";

const URL_BASE = "https://ref.supabase.co/functions/v1/mcp";

function memStore() {
  const trades: (TradeRow & { id: number; date: string; alpacaOrderId?: string })[] = [];
  let settings: GuardConfig | null = null;
  const notes: { id: number; created_at: string; note_date: string; title: string | null; tags: string[]; body: string }[] = [];
  const snapshots: Record<string, unknown> = {};
  const store: Store = {
    countOrdersToday: async (d) => trades.filter((t) => t.date === d && t.source === "mcp" && ["pending", "accepted", "canceled"].includes(t.status)).length,
    insertTrade: async (date, t) => (trades.push({ ...t, id: trades.length + 1, date }), trades.length),
    finishTrade: async (id, p) => void Object.assign(trades[id - 1], { status: p.status, alpacaOrderId: p.alpacaOrderId, error: p.error }),
    markCanceled: async (oid) => void trades.filter((t) => t.alpacaOrderId === oid).forEach((t) => ((t as any).status = "canceled")),
    recordSnapshotIfFirstToday: async (d, equity, cash, spy) => void (snapshots[d] ??= { equity, cash, spy }),
    saveNote: async (date, n) => (notes.push({ id: notes.length + 1, created_at: new Date().toISOString(), note_date: date, title: n.title ?? null, tags: n.tags, body: n.body }), notes.length),
    listNotes: async (limit, tag) => notes.filter((n) => !tag || n.tags.includes(tag)).slice().reverse().slice(0, limit),
    getSettings: async () => settings,
    saveSettings: async (c) => void (settings = c),
    listTrades: async (limit, symbol) => trades.filter((t) => !symbol || t.symbol === symbol).slice().reverse().slice(0, limit),
  };
  return { store, trades, snapshots, notes };
}

const mk = (authenticate = async (t: string) => (t === "good" ? { login: "oliver" } : null)) => {
  const m = memStore();
  const handler = createHandler({
    store: m.store,
    alpaca: new Alpaca({ keyId: "k", secretKey: "s" }),
    defaultCfg: parseConfig({ MAX_ORDER_PCT: "10", MAX_POSITION_PCT: "20", MAX_ORDERS_PER_DAY: "10", SYMBOL_ALLOWLIST: "" }),
    siteOrigins: ["https://portfolio.oliverseydlitz.com"],
    resourceUrl: URL_BASE,
    authServerUrl: "https://ref.supabase.co/auth/v1",
    authenticate,
  });
  return { ...m, handler };
};

// ---- fake Alpaca over global fetch ----
let market = { is_open: true };
let liveBarT = ""; // SPY snapshot daily-bar timestamp; "" = no live day
const account = { equity: "100000", last_equity: "99000", cash: "100000", buying_power: "100000", portfolio_value: "100000", status: "ACTIVE" };
let positions: any[] = [];
const NAMES: Record<string, string> = { SPY: "SPDR S&P 500 ETF Trust", TLT: "iShares 20+ Year Treasury Bond ETF", AAPL: "Apple Inc. Common Stock" };
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
    if (p === "/v2/account/portfolio/history") return json({ timestamp: [1790000000, 1790086400, 1790172800], equity: [100000, 101000, 102000], base_value: 100000 });
    if (p === "/v2/orders") return json([]);
    if (p.startsWith("/v2/assets/")) {
      const s = p.split("/").pop()!;
      if (s === "NOPE") return json({ message: "asset not found" }, 404);
      return json({ symbol: s, class: s === "BTCUS" ? "crypto" : "us_equity", status: "active", tradable: true, fractionable: true, shortable: true, exchange: "ARCA", name: NAMES[s] ?? s });
    }
    if (p === "/v2/account/portfolio/history") {
      return json({ timestamp: [1790000000, 1790086400, 1790172800].map((t) => t), equity: [100000, 101000, 102000], base_value: 100000 });
    }
  }
  if (url.hostname === "data.alpaca.markets" && url.pathname === "/v2/stocks/snapshots") {
    const out: any = {};
    for (const s of url.searchParams.get("symbols")!.split(","))
      out[s] = { latestTrade: { p: s === "SPY" && liveBarT ? 721 : 100, t: "" }, latestQuote: { ap: 100, bp: 99.9, as: 1, bs: 1, t: "" }, dailyBar: { o: 1, h: 1, l: 1, c: 100, v: 1, t: s === "SPY" ? liveBarT : "" }, prevDailyBar: { c: 99 } };
    return json(out);
  }
  if (url.hostname === "data.alpaca.markets" && url.pathname === "/v2/stocks/bars") {
    const days = [0, 1, 2].map((i) => new Date(1790000000 * 1000 + i * 86400_000));
    return json({ bars: { SPY: days.map((d, i) => ({ t: d.toISOString(), o: 1, h: 1, l: 1, c: 700 + i * 7, v: 1 })) } });
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

  it("lists all eleven tools", async () => {
    const { body } = await rpc(mk().handler, "tools/list", {});
    expect(body.result.tools.map((t: any) => t.name).sort()).toEqual(
      ["cancel_order", "get_account", "get_bars", "get_market_clock", "get_notes", "get_orders", "get_positions", "get_quotes", "get_trade_log", "place_order", "save_note"],
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

  it("save_note / get_notes carry a no-trade day over to the next run", async () => {
    const { handler, trades, notes } = mk();
    const saved = await call(handler, "save_note", { title: "No trades", body: "Held everything. Watching NVDA earnings; re-check if it gaps below 220.", tags: ["Daily", "watchlist", "daily"] });
    expect(saved.isError).toBe(false);
    expect(JSON.parse(saved.text)).toMatchObject({ note_id: 1 });
    expect(notes[0].tags).toEqual(["daily", "watchlist"]); // lower-cased and de-duplicated
    expect(trades).toHaveLength(0); // a note is not a trade
    await call(handler, "save_note", { body: "Second note, different tag.", tags: ["thesis"] });
    const all = JSON.parse((await call(handler, "get_notes", { limit: 10 })).text);
    expect(all.map((n: any) => n.id)).toEqual([2, 1]); // newest first
    const daily = JSON.parse((await call(handler, "get_notes", { tag: "DAILY" })).text);
    expect(daily).toHaveLength(1);
    expect(daily[0].body).toMatch(/NVDA earnings/);
  });

  it("rejects empty and oversized notes", async () => {
    const { handler, notes } = mk();
    expect((await call(handler, "save_note", { body: "   " })).isError).toBe(true);
    expect((await call(handler, "save_note", { body: "x".repeat(8001) })).isError).toBe(true);
    expect(notes).toHaveLength(0);
  });

  it("get_trade_log reads back decisions", async () => {
    const { handler } = mk();
    await call(handler, "place_order", { symbol: "SPY", side: "buy", qty: 1, reason: "log readback test" });
    expect(JSON.parse((await call(handler, "get_trade_log", { limit: 5 })).text)[0].reason).toBe("log readback test");
  });
});

// ---------------- dashboard API ----------------
const api = async (h: (r: Request) => Promise<Response>, method: string, path: string, body?: unknown, token = "good", origin?: string) => {
  const res = await h(
    new Request(`${URL_BASE}/api${path}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", ...(origin ? { origin } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
  return { status: res.status, headers: res.headers, body: await res.json().catch(() => null) as any };
};

describe("dashboard API", () => {
  beforeAll(() => void vi.stubGlobal("fetch", vi.fn(alpacaFetch)));
  afterEach(() => {
    market = { is_open: true };
    positions = [];
    placed.length = 0;
  });

  it("requires the allowlisted bearer token", async () => {
    const { handler } = mk();
    expect((await api(handler, "GET", "/portfolio", undefined, "")).status).toBe(401);
    expect((await api(handler, "GET", "/portfolio", undefined, "bad")).status).toBe(401);
    expect((await api(handler, "PUT", "/settings", { maxOrderPct: 99 }, "bad")).status).toBe(401);
  });

  it("only reflects the site origin in CORS", async () => {
    const { handler } = mk();
    const ok = await api(handler, "GET", "/portfolio", undefined, "good", "https://portfolio.oliverseydlitz.com");
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://portfolio.oliverseydlitz.com");
    const evil = await api(handler, "GET", "/portfolio", undefined, "good", "https://evil.example");
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("returns portfolio with categories, allocation and best/worst", async () => {
    positions = [
      { symbol: "SPY", qty: "10", avg_entry_price: "700", market_value: "7700", current_price: "770", unrealized_pl: "700", unrealized_plpc: "0.1", unrealized_intraday_pl: "10", unrealized_intraday_plpc: "0.001", side: "long" },
      { symbol: "TLT", qty: "50", avg_entry_price: "90", market_value: "4000", current_price: "80", unrealized_pl: "-500", unrealized_plpc: "-0.111", unrealized_intraday_pl: "-5", unrealized_intraday_plpc: "-0.001", side: "long" },
      { symbol: "AAPL", qty: "5", avg_entry_price: "200", market_value: "1100", current_price: "220", unrealized_pl: "100", unrealized_plpc: "0.1", unrealized_intraday_pl: "0", unrealized_intraday_plpc: "0", side: "long" },
    ];
    const { body } = await api(mk().handler, "GET", "/portfolio");
    expect(body.positions.map((p: any) => [p.symbol, p.category])).toEqual([["SPY", "ETF"], ["TLT", "Bond ETF"], ["AAPL", "Stock"]]);
    expect(body.allocation).toEqual([
      { label: "Stocks", value: 1100 }, { label: "ETFs", value: 7700 }, { label: "Bond ETFs", value: 4000 }, { label: "Cash", value: 100000 },
    ]);
    expect(body.performers.best[0].symbol).toBe("SPY");
    expect(body.performers.worst.map((p: any) => p.symbol)).toEqual(["TLT"]);
    expect(body.performers.best.map((p: any) => p.symbol)).not.toContain("TLT");
    expect(body.settings).toMatchObject({ maxOrderPct: 10, maxPositionPct: 20, maxOrdersPerDay: 10 });
  });

  it("returns equity vs SPY rebased to 100", async () => {
    const { body } = await api(mk().handler, "GET", "/history?period=1M");
    expect(body.points).toHaveLength(3);
    expect(body.points[0]).toMatchObject({ portfolio: 100, spy: 100 });
    expect(body.points[2].portfolio).toBeCloseTo(102);
  });

  it("adds today's live point when the daily history hasn't caught up, and refreshes it when it has", async () => {
    const day = (i: number) => new Date(1790000000 * 1000 + i * 86400_000);
    try {
      // Today (day 3) is missing from the history: appended from live equity (100000) and SPY's latest trade (721).
      liveBarT = day(3).toISOString();
      let { body } = await api(mk().handler, "GET", "/history?period=1M");
      expect(body.points).toHaveLength(4);
      expect(body.points[3]).toMatchObject({ date: nyDate(day(3)), equity: 100000, portfolio: 100 });
      expect(body.points[3].spy).toBeCloseTo((721 / 700) * 100);
      // Today is already the last history day: its values are replaced with the live ones.
      liveBarT = day(2).toISOString();
      ({ body } = await api(mk().handler, "GET", "/history?period=1M"));
      expect(body.points).toHaveLength(3);
      expect(body.points[2]).toMatchObject({ equity: 100000, portfolio: 100 });
      expect(body.points[2].spy).toBeCloseTo((721 / 700) * 100);
    } finally {
      liveBarT = "";
    }
  });

  it("manual orders go through the guardrails, are logged as manual, and skip the daily cap", async () => {
    const { handler, trades } = mk();
    for (let i = 0; i < 10; i++) await call(handler, "place_order", { symbol: "SPY", side: "buy", qty: 1, reason: `claude order number ${i + 1}` });
    expect((await call(handler, "place_order", { symbol: "SPY", side: "buy", qty: 1, reason: "claude eleventh order" })).text).toMatch(/MAX_ORDERS_PER_DAY/);
    const ok = await api(handler, "POST", "/order", { symbol: "spy", side: "buy", qty: 1, note: "my own trade" });
    expect(ok.status).toBe(200);
    expect(trades.at(-1)).toMatchObject({ source: "manual", reason: "my own trade", status: "accepted" });
    const big = await api(handler, "POST", "/order", { symbol: "SPY", side: "buy", qty: 500 });
    expect(big.status).toBe(422);
    expect(big.body.message).toMatch(/MAX_ORDER_PCT/);
    const short = await api(handler, "POST", "/order", { symbol: "SPY", side: "sell", qty: 1 });
    expect(short.body.message).toMatch(/NO_SHORTING/);
  });

  it("saves limits, enforces ceilings, and the new limits apply to Claude's orders", async () => {
    const { handler } = mk();
    expect((await api(handler, "PUT", "/settings", { maxOrderPct: 150, maxPositionPct: 20, maxOrdersPerDay: 10, allowlist: "" })).status).toBe(400);
    expect((await api(handler, "PUT", "/settings", { maxOrderPct: 10, maxPositionPct: 20, maxOrdersPerDay: 0, allowlist: "" })).status).toBe(400);
    expect((await api(handler, "PUT", "/settings", { maxOrderPct: 10, maxPositionPct: 20, maxOrdersPerDay: 10, allowlist: "SPY, $$$" })).status).toBe(400);
    const saved = await api(handler, "PUT", "/settings", { maxOrderPct: 1, maxPositionPct: 5, maxOrdersPerDay: 2, allowlist: "spy, qqq" });
    expect(saved.body.settings).toEqual({ maxOrderPct: 1, maxPositionPct: 5, maxOrdersPerDay: 2, allowlist: ["SPY", "QQQ"] });
    expect((await call(handler, "place_order", { symbol: "SPY", side: "buy", qty: 20, reason: "now over the 1 percent cap" })).text).toMatch(/MAX_ORDER_PCT/);
    expect((await call(handler, "place_order", { symbol: "AAPL", side: "buy", qty: 1, reason: "not on the allowlist" })).text).toMatch(/SYMBOL_ALLOWLIST/);
  });

  it("exposes notes to the dashboard", async () => {
    const { handler } = mk();
    await call(handler, "save_note", { body: "Dashboard-visible note", tags: ["daily"] });
    const r = await api(handler, "GET", "/notes");
    expect(r.status).toBe(200);
    expect(r.body.notes[0].body).toBe("Dashboard-visible note");
    expect((await api(handler, "GET", "/notes", undefined, "bad")).status).toBe(401);
  });

  it("gives Claude no way to change its own limits", async () => {
    const { body } = await rpc(mk().handler, "tools/list", {});
    expect(body.result.tools.map((t: any) => t.name).join(",")).not.toMatch(/setting|limit/i);
  });
});

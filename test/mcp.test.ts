import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Alpaca } from "../supabase/functions/mcp/alpaca.ts";
import { createHandler } from "../supabase/functions/mcp/app.ts";
import { allowedGithubLogin } from "../supabase/functions/mcp/auth.ts";
import { parseConfig, type GuardConfig } from "../supabase/functions/mcp/guardrails.ts";
import { Telegram } from "../supabase/functions/mcp/telegram.ts";
import { parseTrade } from "../supabase/functions/mcp/telegram-bot.ts";
import { type ApprovalInput, nyDate, type Store, type TradeRow } from "../supabase/functions/mcp/store.ts";

const URL_BASE = "https://ref.supabase.co/functions/v1/mcp";

function memStore() {
  const trades: (TradeRow & { id: number; date: string; alpacaOrderId?: string })[] = [];
  let settings: GuardConfig | null = null;
  const notes: { id: number; created_at: string; note_date: string; title: string | null; tags: string[]; body: string }[] = [];
  const snapshots: Record<string, unknown> = {};
  const report = { everyHours: 0, lastAt: null as string | null };
  const approvals: (ApprovalInput & { id: number; status: string; result?: string })[] = [];
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
    createApproval: async (a) => (approvals.push({ ...a, id: approvals.length + 1, status: "pending" }), approvals.length),
    decideApproval: async (id, status) => {
      const a = approvals.find((x) => x.id === id);
      if (!a || a.status !== "pending" || Date.parse(a.expiresAt) <= Date.now()) return null;
      a.status = status;
      return a;
    },
    getReportSchedule: async () => ({ ...report }),
    saveReportEvery: async (h) => void (report.everyHours = h),
    markReported: async (at) => void (report.lastAt = at),
    finishApproval: async (id, p) => void Object.assign(approvals[id - 1], { ...(p.status ? { status: p.status } : {}), result: p.result }),
  };
  return { store, trades, snapshots, notes, approvals, report };
}

const mk = (authenticate = async (t: string) => (t === "good" ? { login: "oliver" } : null), withApproval = false) => {
  const m = memStore();
  const handler = createHandler({
    store: m.store,
    alpaca: new Alpaca({ keyId: "k", secretKey: "s" }),
    defaultCfg: parseConfig({ MAX_ORDER_PCT: "10", MAX_POSITION_PCT: "20", MAX_ORDERS_PER_DAY: "10", SYMBOL_ALLOWLIST: "" }),
    siteOrigins: ["https://portfolio.oliverseydlitz.com"],
    resourceUrl: URL_BASE,
    authServerUrl: "https://ref.supabase.co/auth/v1",
    authenticate,
    approval: withApproval ? { telegram: new Telegram("tok", "4242"), thresholdPct: 5, ttlMinutes: 30, webhookSecret: "whsec" } : undefined,
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
const telegram: { method: string; body: any }[] = [];
let telegramDown = false;
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
  if (url.hostname === "api.telegram.org") {
    const method = url.pathname.split("/").pop()!;
    const body = JSON.parse(init.body);
    telegram.push({ method, body });
    if (telegramDown) return json({ ok: false, description: "Bad Gateway" }, 502);
    return json({ ok: true, result: method === "sendMessage" ? { message_id: 77 } : true });
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
    telegram.length = 0;
    telegramDown = false;
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
    expect(saved.body.settings).toEqual({ maxOrderPct: 1, maxPositionPct: 5, maxOrdersPerDay: 2, allowlist: ["SPY", "QQQ"], reportEveryHours: 0 });
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

describe("Telegram approval for big orders", () => {
  beforeAll(() => void vi.stubGlobal("fetch", vi.fn(alpacaFetch)));
  afterEach(() => {
    market = { is_open: true };
    placed.length = 0;
    telegram.length = 0;
    telegramDown = false;
  });
  const tap = (h: (r: Request) => Promise<Response>, data: string, o: { secret?: string; from?: number; chat?: number } = {}) =>
    h(
      new Request(`${URL_BASE}/telegram`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": o.secret ?? "whsec" },
        body: JSON.stringify({ callback_query: { id: "cb1", data, from: { id: o.from ?? 4242 }, message: { message_id: 77, chat: { id: o.chat ?? 4242 } } } }),
      }),
    );
  const big = { symbol: "SPY", side: "buy", qty: 60, reason: "Rotating into the benchmark on a pullback" }; // $6,000 = 6% of equity
  const small = { ...big, qty: 40 }; // 4%

  it("holds a big order, messages Telegram, and places nothing yet", async () => {
    const { handler, trades, approvals } = mk(undefined, true);
    const r = await call(handler, "place_order", big);
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/PENDING APPROVAL \(#1\)/);
    expect(placed).toHaveLength(0);
    expect(trades).toHaveLength(0);
    expect(approvals[0]).toMatchObject({ symbol: "SPY", qty: 60, status: "pending" });
    expect(telegram[0].method).toBe("sendMessage");
    expect(telegram[0].body.chat_id).toBe("4242");
    expect(telegram[0].body.reply_markup.inline_keyboard[0].map((b: any) => b.callback_data)).toEqual(["a:1", "r:1"]);
  });

  it("sends small orders straight through, and everything straight through when Telegram isn't configured", async () => {
    const gated = mk(undefined, true);
    expect((await call(gated.handler, "place_order", small)).isError).toBe(false);
    expect(placed).toHaveLength(1);
    expect(telegram).toHaveLength(0);
    expect((await call(mk().handler, "place_order", big)).isError).toBe(false);
    expect(placed).toHaveLength(2);
  });

  it("still applies the guardrails before asking you", async () => {
    const { handler, approvals } = mk(undefined, true);
    market = { is_open: false };
    expect((await call(handler, "place_order", big)).text).toMatch(/MARKET_CLOSED/);
    expect(approvals).toHaveLength(0);
    expect(telegram).toHaveLength(0);
  });

  it("Yes places the order once (double tap does nothing), logs it, and edits the message", async () => {
    const { handler, trades } = mk(undefined, true);
    await call(handler, "place_order", big);
    expect((await tap(handler, "a:1")).status).toBe(200);
    expect(placed).toHaveLength(1);
    expect(placed[0]).toMatchObject({ symbol: "SPY", side: "buy", qty: "60" });
    expect(trades[0]).toMatchObject({ status: "accepted", source: "mcp" });
    expect(trades[0].reason).toMatch(/approved via Telegram #1/);
    expect(telegram.find((t) => t.method === "editMessageText")!.body.text).toMatch(/Placed #1/);
    await tap(handler, "a:1");
    expect(placed).toHaveLength(1);
  });

  it("No places nothing, and a later Yes on the same request does nothing", async () => {
    const { handler, approvals } = mk(undefined, true);
    await call(handler, "place_order", big);
    await tap(handler, "r:1");
    await tap(handler, "a:1");
    expect(placed).toHaveLength(0);
    expect(approvals[0].status).toBe("declined");
  });

  it("re-checks the guardrails at approval time (market closed by then)", async () => {
    const { handler, approvals } = mk(undefined, true);
    await call(handler, "place_order", big);
    market = { is_open: false };
    await tap(handler, "a:1");
    expect(placed).toHaveLength(0);
    expect(approvals[0].status).toBe("failed");
    expect(telegram.find((t) => t.method === "editMessageText")!.body.text).toMatch(/NOT placed/);
  });

  it("expired requests can't be approved", async () => {
    const { handler, approvals } = mk(undefined, true);
    await call(handler, "place_order", big);
    approvals[0].expiresAt = new Date(Date.now() - 1000).toISOString();
    await tap(handler, "a:1");
    expect(placed).toHaveLength(0);
  });

  it("ignores wrong secret, other chats and other users", async () => {
    const { handler } = mk(undefined, true);
    await call(handler, "place_order", big);
    expect((await tap(handler, "a:1", { secret: "nope" })).status).toBe(403);
    await tap(handler, "a:1", { from: 999 });
    await tap(handler, "a:1", { chat: 999 });
    expect(placed).toHaveLength(0);
  });

  it("fails closed when Telegram is down: nothing is placed and Claude is told", async () => {
    const { handler, approvals } = mk(undefined, true);
    telegramDown = true;
    const r = await call(handler, "place_order", big);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/NOT PLACED/);
    expect(placed).toHaveLength(0);
    expect(approvals[0].status).toBe("failed");
  });
});

describe("Telegram commands and scheduled reports", () => {
  beforeAll(() => void vi.stubGlobal("fetch", vi.fn(alpacaFetch)));
  afterEach(() => {
    market = { is_open: true };
    positions = [];
    placed.length = 0;
    telegram.length = 0;
  });
  const say = async (h: (r: Request) => Promise<Response>, text: string, from = 4242) => {
    telegram.length = 0;
    const res = await h(
      new Request(`${URL_BASE}/telegram`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "whsec" },
        body: JSON.stringify({ message: { message_id: 1, text, from: { id: from }, chat: { id: from } } }),
      }),
    );
    expect(res.status).toBe(200);
    return telegram.find((t) => t.method === "sendMessage")?.body.text as string | undefined;
  };
  const tick = (h: (r: Request) => Promise<Response>, secret = "whsec") =>
    h(new Request(`${URL_BASE}/telegram/tick`, { method: "POST", headers: { "x-telegram-bot-api-secret-token": secret } }));

  it("parses trade sizes", () => {
    expect(parseTrade("5 TSLA")).toEqual({ ok: true, symbol: "TSLA", qty: 5, limit: undefined });
    expect(parseTrade("tsla 5")).toMatchObject({ ok: true, symbol: "TSLA", qty: 5 });
    expect(parseTrade("$1,500 TSLA")).toMatchObject({ ok: true, symbol: "TSLA", notional: 1500 });
    expect(parseTrade("5 TSLA @ 240.5")).toMatchObject({ ok: true, qty: 5, limit: 240.5 });
    expect(parseTrade("5 TSLA limit 240")).toMatchObject({ ok: true, qty: 5, limit: 240 });
    expect(parseTrade("all TSLA")).toMatchObject({ ok: true, all: true });
    expect(parseTrade("$500 TSLA @ 240").ok).toBe(false);
    expect(parseTrade("TSLA").ok).toBe(false);
    expect(parseTrade("-5 TSLA").ok).toBe(false);
  });

  it("/buy places a manual order through the guardrails", async () => {
    const { handler, trades } = mk(undefined, true);
    expect(await say(handler, "/buy 5 SPY")).toMatch(/✅ BUY 5 SPY/);
    expect(placed[0]).toMatchObject({ symbol: "SPY", side: "buy", qty: "5", type: "market" });
    expect(trades[0]).toMatchObject({ source: "manual", status: "accepted", reason: "Telegram: /buy 5 SPY" });
    expect(await say(handler, "/buy@MyBot $500 SPY")).toMatch(/✅/);
    expect(placed[1]).toMatchObject({ notional: "500" });
    market = { is_open: false };
    expect(await say(handler, "/buy 5 SPY")).toMatch(/Not placed.*MARKET_CLOSED/);
    expect(placed).toHaveLength(2);
  });

  it("/sell all sells the whole position; can't sell what you don't hold", async () => {
    const { handler } = mk(undefined, true);
    expect(await say(handler, "/sell all SPY")).toMatch(/don't hold SPY/);
    positions = [{ symbol: "SPY", qty: "12.5", market_value: "1250", side: "long", avg_entry_price: "100", current_price: "100", unrealized_pl: "0", unrealized_plpc: "0", unrealized_intraday_pl: "0" }];
    expect(await say(handler, "/sell all SPY")).toMatch(/✅ SELL 12.5 SPY/);
    expect(placed[0]).toMatchObject({ side: "sell", qty: "12.5" });
  });

  it("/note saves a note Claude reads via get_notes; /notes lists them", async () => {
    const { handler, notes } = mk(undefined, true);
    expect(await say(handler, "/note Trim NVDA if it pops on earnings")).toMatch(/Saved note #1/);
    expect(notes[0]).toMatchObject({ body: "Trim NVDA if it pops on earnings", tags: ["telegram", "oliver"] });
    expect((await call(handler, "get_notes", {})).text).toMatch(/Trim NVDA/);
    expect(await say(handler, "/notes")).toMatch(/#1.*\n.*Trim NVDA/);
  });

  it("/portfolio reports equity, cash and positions; /help and unknown commands show help", async () => {
    const { handler } = mk(undefined, true);
    positions = [{ symbol: "SPY", qty: "10", market_value: "1000", side: "long", avg_entry_price: "90", current_price: "100", unrealized_pl: "100", unrealized_plpc: "0.111", unrealized_intraday_pl: "5", unrealized_intraday_plpc: "0.005" }];
    const r = await say(handler, "/portfolio");
    expect(r).toMatch(/Equity \$100,000\.00/);
    expect(r).toMatch(/Cash \$100,000\.00/);
    expect(r).toMatch(/SPY.*\$1,000\.00.*\+11\.10% total/);
    expect(await say(handler, "/help")).toMatch(/\/buy 5 TSLA/);
    expect(await say(handler, "/wat")).toMatch(/Unknown command/);
  });

  it("ignores messages from anyone else", async () => {
    const { handler } = mk(undefined, true);
    expect(await say(handler, "/buy 5 SPY", 999)).toBeUndefined();
    expect(placed).toHaveLength(0);
  });

  it("report tick follows the dashboard setting and only sends when due", async () => {
    const { handler, report } = mk(undefined, true);
    expect((await tick(handler, "nope")).status).toBe(403);
    expect(await (await tick(handler)).json()).toEqual({ result: "off" });
    report.everyHours = 1;
    expect(await (await tick(handler)).json()).toEqual({ result: "sent" });
    expect(telegram.find((t) => t.method === "sendMessage")!.body.text).toMatch(/Hourly update/);
    expect(await (await tick(handler)).json()).toEqual({ result: "not_due" });
    report.lastAt = new Date(Date.now() - 3600_000).toISOString();
    market = { is_open: false };
    expect(await (await tick(handler)).json()).toEqual({ result: "market_closed" }); // hourly waits for the open
    report.everyHours = 24;
    report.lastAt = new Date(Date.now() - 24 * 3600_000 + 5 * 60_000).toISOString(); // a few minutes early is fine
    expect(await (await tick(handler)).json()).toEqual({ result: "sent" }); // daily goes out even when closed
  });

  it("the dashboard saves the report cadence and rejects odd values", async () => {
    const { handler, report } = mk(undefined, true);
    const put = (body: unknown) =>
      handler(new Request(`${URL_BASE}/api/settings`, { method: "PUT", headers: { authorization: "Bearer good", "content-type": "application/json" }, body: JSON.stringify(body) }));
    const base = { maxOrderPct: 10, maxPositionPct: 20, maxOrdersPerDay: 10, allowlist: "" };
    const ok = await put({ ...base, reportEveryHours: 4 });
    expect((await ok.json()).settings.reportEveryHours).toBe(4);
    expect(report.everyHours).toBe(4);
    expect((await put({ ...base, reportEveryHours: 3 })).status).toBe(400);
    expect(report.everyHours).toBe(4);
    const pf = await (await handler(new Request(`${URL_BASE}/api/portfolio`, { headers: { authorization: "Bearer good" } }))).json();
    expect(pf.settings.reportEveryHours).toBe(4);
    expect(pf.telegram).toEqual({ enabled: true });
  });
});

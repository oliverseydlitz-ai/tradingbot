import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createMcpHandler } from "agents/mcp/server";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import worker from "../src/index";
import { createServer } from "../src/tools";

// Minimal D1 shim over node:sqlite so the real SQL + migration run in tests.
function fakeD1(): D1Database {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync("migrations/0001_init.sql", "utf8"));
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async () => (db.prepare(sql).get(...(args as any[])) as any) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...(args as any[])) }),
    run: async () => {
      const r = db.prepare(sql).run(...(args as any[]));
      return { meta: { last_row_id: Number(r.lastInsertRowid), changes: r.changes } };
    },
  });
  return { prepare: (sql: string) => stmt(sql) } as unknown as D1Database;
}

function fakeKV(): KVNamespace {
  const m = new Map<string, string>();
  return {
    get: async (k: string, o?: any) => {
      const v = m.get(k);
      return v == null ? null : o === "json" || o?.type === "json" ? JSON.parse(v) : v;
    },
    put: async (k: string, v: string) => {
      m.set(k, v);
    },
    delete: async (k: string) => {
      m.delete(k);
    },
    list: async () => ({ keys: [...m.keys()].map((name) => ({ name })), list_complete: true }),
  } as unknown as KVNamespace;
}

const mkEnv = (): Env => ({
  OAUTH_KV: fakeKV(),
  DB: fakeD1(),
  OAUTH_PROVIDER: undefined as any,
  GITHUB_CLIENT_ID: "x",
  GITHUB_CLIENT_SECRET: "x",
  ALPACA_KEY_ID: "k",
  ALPACA_SECRET_KEY: "s",
  PUBLIC_URL: "https://portfolio.oliverseydlitz.com",
  ALLOWED_GITHUB_LOGIN: "oliver",
  MAX_ORDER_PCT: "10",
  MAX_POSITION_PCT: "20",
  MAX_ORDERS_PER_DAY: "10",
  SYMBOL_ALLOWLIST: "",
});
const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

describe("auth surface", () => {
  it("rejects unauthenticated /mcp with a Bearer challenge", async () => {
    const res = await worker.fetch(
      new Request("https://portfolio.oliverseydlitz.com/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
      mkEnv(),
      ctx,
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Bearer/);
  });

  it("rejects a garbage bearer token", async () => {
    const res = await worker.fetch(
      new Request("https://portfolio.oliverseydlitz.com/mcp", {
        method: "POST",
        headers: { authorization: "Bearer nope", "content-type": "application/json" },
        body: "{}",
      }),
      mkEnv(),
      ctx,
    );
    expect(res.status).toBe(401);
  });

  it("publishes OAuth discovery metadata", async () => {
    const env = mkEnv();
    const as = await worker.fetch(
      new Request("https://portfolio.oliverseydlitz.com/.well-known/oauth-authorization-server"),
      env,
      ctx,
    );
    expect(as.status).toBe(200);
    expect(((await as.json()) as any).registration_endpoint).toBe("https://portfolio.oliverseydlitz.com/register");
    const prm = await worker.fetch(
      new Request("https://portfolio.oliverseydlitz.com/.well-known/oauth-protected-resource/mcp"),
      env,
      ctx,
    );
    expect(prm.status).toBe(200);
  });
});

// Fake Alpaca over global fetch.
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
      return json({
        id: crypto.randomUUID(),
        ...body,
        status: "accepted",
        filled_qty: "0",
        qty: body.qty ?? null,
        notional: body.notional ?? null,
        limit_price: body.limit_price ?? null,
        filled_avg_price: null,
        created_at: "",
        submitted_at: "",
        filled_at: null,
      });
    }
    if (p === "/v2/orders") return json([]);
    if (p.startsWith("/v2/assets/")) {
      const sym = p.split("/").pop()!;
      if (sym === "NOPE") return json({ message: "asset not found" }, 404);
      return json({
        symbol: sym,
        class: sym === "BTCUS" ? "crypto" : "us_equity",
        status: "active",
        tradable: true,
        fractionable: true,
        shortable: true,
        exchange: "ARCA",
        name: sym,
      });
    }
  }
  if (url.hostname === "data.alpaca.markets" && url.pathname === "/v2/stocks/snapshots") {
    const out: any = {};
    for (const s of url.searchParams.get("symbols")!.split(","))
      out[s] = {
        latestTrade: { p: 100, t: "" },
        latestQuote: { ap: 100, bp: 99.9, as: 1, bs: 1, t: "" },
        dailyBar: { o: 1, h: 1, l: 1, c: 100, v: 1, t: "" },
        prevDailyBar: { c: 99 },
      };
    return json(out);
  }
  return json({ message: `unmocked ${url}` }, 500);
}

async function call(env: Env, name: string, args: Record<string, unknown>) {
  const h = createMcpHandler(() => createServer(env), { route: "/mcp" });
  const res = await h(
    new Request("https://portfolio.oliverseydlitz.com/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
    env,
    ctx,
  );
  const raw = await res.text();
  const dataLine = raw.split("\n").find((l) => l.startsWith("data:"));
  const msg = JSON.parse(dataLine ? dataLine.slice(5) : raw);
  if (msg.error) return { isError: true, text: JSON.stringify(msg.error) };
  return { isError: !!msg.result.isError, text: msg.result.content[0].text as string };
}

describe("tools (mocked Alpaca)", () => {
  beforeAll(() => {
    vi.stubGlobal("fetch", vi.fn(alpacaFetch));
  });
  afterEach(() => {
    market = { is_open: true };
    positions = [];
    placed.length = 0;
  });

  it("get_account stores one snapshot per day", async () => {
    const env = mkEnv();
    const r = await call(env, "get_account", {});
    expect(JSON.parse(r.text).equity).toBe(100000);
    await call(env, "get_account", {});
    const rows = (await env.DB.prepare("SELECT * FROM snapshots").all()).results;
    expect(rows).toHaveLength(1);
    expect((rows[0] as any).spy_close).toBe(100);
  });

  it("places an order and logs it with reason + equity", async () => {
    const env = mkEnv();
    const r = await call(env, "place_order", { symbol: "spy", side: "buy", qty: 50, reason: "Core holding to match benchmark" });
    expect(r.isError).toBe(false);
    expect(placed[0]).toMatchObject({ symbol: "SPY", side: "buy", qty: "50", type: "market", time_in_force: "day" });
    const row: any = (await env.DB.prepare("SELECT * FROM trades").all()).results[0];
    expect(row).toMatchObject({ status: "accepted", reason: "Core holding to match benchmark", equity_at_time: 100000 });
    expect(row.alpaca_order_id).toBeTruthy();
  });

  it("rejects closed market, oversize, short, crypto, unknown, missing reason", async () => {
    const env = mkEnv();
    market = { is_open: false };
    expect((await call(env, "place_order", { symbol: "SPY", side: "buy", qty: 1, reason: "market is closed test" })).text).toMatch(/MARKET_CLOSED/);
    market = { is_open: true };
    expect((await call(env, "place_order", { symbol: "SPY", side: "buy", qty: 101, reason: "oversize order test" })).text).toMatch(/MAX_ORDER_PCT/);
    expect((await call(env, "place_order", { symbol: "SPY", side: "sell", qty: 1, reason: "short sell attempt test" })).text).toMatch(/NO_SHORTING/);
    expect((await call(env, "place_order", { symbol: "BTCUS", side: "buy", qty: 1, reason: "crypto attempt test" })).text).toMatch(/ASSET_CLASS/);
    expect((await call(env, "place_order", { symbol: "NOPE", side: "buy", qty: 1, reason: "unknown symbol test" })).text).toMatch(/UNKNOWN_SYMBOL/);
    expect((await call(env, "place_order", { symbol: "SPY", side: "buy", qty: 1, reason: "" })).isError).toBe(true);
    expect(placed).toHaveLength(0);
  });

  it("rejects the 11th order of the day", async () => {
    const env = mkEnv();
    for (let i = 0; i < 10; i++) {
      const r = await call(env, "place_order", { symbol: "SPY", side: "buy", qty: 1, reason: `order number ${i + 1} of the day` });
      expect(r.isError).toBe(false);
    }
    const r = await call(env, "place_order", { symbol: "SPY", side: "buy", qty: 1, reason: "the eleventh order" });
    expect(r.text).toMatch(/MAX_ORDERS_PER_DAY/);
    expect(placed).toHaveLength(10);
  });

  it("get_trade_log returns logged decisions", async () => {
    const env = mkEnv();
    await call(env, "place_order", { symbol: "SPY", side: "buy", qty: 1, reason: "log readback test" });
    const r = await call(env, "get_trade_log", { limit: 5 });
    expect(JSON.parse(r.text)[0].reason).toBe("log readback test");
  });
});

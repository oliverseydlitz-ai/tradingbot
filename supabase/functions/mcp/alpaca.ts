// Paper-only by construction. There is deliberately no env flag for the live
// endpoint: going live means editing this constant and redeploying.
export const ALPACA_TRADING_URL = "https://paper-api.alpaca.markets/v2";
export const ALPACA_DATA_URL = "https://data.alpaca.markets/v2";

export class AlpacaError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface Account {
  equity: string;
  last_equity: string;
  cash: string;
  buying_power: string;
  portfolio_value: string;
  status: string;
  pattern_day_trader?: boolean;
  trading_blocked?: boolean;
  account_blocked?: boolean;
}

export interface Position {
  symbol: string;
  qty: string;
  avg_entry_price: string;
  market_value: string;
  current_price: string;
  unrealized_pl: string;
  unrealized_plpc: string;
  unrealized_intraday_pl: string;
  side: string;
}

export interface Clock {
  is_open: boolean;
  timestamp: string;
  next_open: string;
  next_close: string;
}

export interface Asset {
  symbol: string;
  class: string;
  status: string;
  tradable: boolean;
  fractionable: boolean;
  shortable: boolean;
  exchange: string;
  name: string;
}

export interface Order {
  id: string;
  symbol: string;
  side: string;
  type: string;
  status: string;
  qty: string | null;
  notional: string | null;
  filled_qty: string;
  filled_avg_price: string | null;
  limit_price: string | null;
  created_at: string;
  submitted_at: string | null;
  filled_at: string | null;
}

export class Alpaca {
  constructor(private keys: { keyId: string; secretKey: string }) {}

  private async req<T>(base: string, path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(base + path, {
      ...init,
      headers: {
        "APCA-API-KEY-ID": this.keys.keyId,
        "APCA-API-SECRET-KEY": this.keys.secretKey,
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
    });
    const text = await res.text();
    if (!res.ok) {
      // Alpaca error bodies are {code, message}; never echo request headers.
      let msg = text;
      try {
        msg = (JSON.parse(text) as { message?: string }).message ?? text;
      } catch {}
      throw new AlpacaError(res.status, `Alpaca ${res.status}: ${msg}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  private trading<T>(path: string, init?: RequestInit) {
    return this.req<T>(ALPACA_TRADING_URL, path, init);
  }
  private data<T>(path: string) {
    return this.req<T>(ALPACA_DATA_URL, path);
  }

  getAccount() {
    return this.trading<Account>("/account");
  }
  getPositions() {
    return this.trading<Position[]>("/positions");
  }
  getClock() {
    return this.trading<Clock>("/clock");
  }
  getAsset(symbol: string) {
    return this.trading<Asset>(`/assets/${encodeURIComponent(symbol)}`);
  }
  getOrders(status: "open" | "closed" | "all", limit: number) {
    return this.trading<Order[]>(
      `/orders?status=${status}&limit=${limit}&direction=desc`,
    );
  }
  placeOrder(body: Record<string, unknown>) {
    return this.trading<Order>("/orders", { method: "POST", body: JSON.stringify(body) });
  }
  cancelOrder(id: string) {
    return this.trading<unknown>(`/orders/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  /** Latest trade + quote + daily bar per symbol (IEX feed: available on free plans). */
  async getSnapshots(symbols: string[]) {
    const q = `symbols=${encodeURIComponent(symbols.join(","))}&feed=iex`;
    const raw = await this.data<Record<string, any>>(`/stocks/snapshots?${q}`);
    return (raw.snapshots ?? raw) as Record<
      string,
      {
        latestTrade?: { p: number; t: string };
        latestQuote?: { ap: number; bp: number; as: number; bs: number; t: string };
        dailyBar?: { o: number; h: number; l: number; c: number; v: number; t: string };
        prevDailyBar?: { c: number; t: string };
      }
    >;
  }

  async getDailyBars(symbol: string, days: number) {
    // Calendar days to look back; ~1.6x covers weekends/holidays for N trading days.
    const start = new Date(Date.now() - Math.ceil(days * 1.6 + 5) * 86400_000)
      .toISOString()
      .slice(0, 10);
    const q = `symbols=${encodeURIComponent(symbol)}&timeframe=1Day&start=${start}&limit=${Math.min(days, 1000)}&adjustment=split&feed=iex&sort=desc`;
    const raw = await this.data<{ bars: Record<string, any[]> | any[] | null }>(`/stocks/bars?${q}`);
    const bars = Array.isArray(raw.bars) ? raw.bars : (raw.bars?.[symbol] ?? []);
    return bars
      .map((b) => ({ date: String(b.t).slice(0, 10), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }))
      .reverse(); // oldest first
  }
}

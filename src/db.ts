export const nyDate = (d = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d); // YYYY-MM-DD

export interface TradeRow {
  symbol: string;
  side: string;
  qty: number | null;
  notional: number | null;
  orderType: string;
  limitPrice: number | null;
  status: "pending" | "accepted" | "failed" | "rejected";
  reason: string;
  equity: number | null;
  error?: string | null;
}

export async function countOrdersToday(db: D1Database, date: string): Promise<number> {
  const r = await db
    .prepare("SELECT COUNT(*) AS n FROM trades WHERE trade_date = ? AND status IN ('pending','accepted','canceled')")
    .bind(date)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

export async function insertTrade(db: D1Database, date: string, t: TradeRow): Promise<number> {
  const r = await db
    .prepare(
      `INSERT INTO trades (trade_date, symbol, side, qty, notional, order_type, limit_price, status, reason, equity_at_time, error)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .bind(date, t.symbol, t.side, t.qty, t.notional, t.orderType, t.limitPrice, t.status, t.reason, t.equity, t.error ?? null)
    .run();
  return r.meta.last_row_id as number;
}

export async function finishTrade(
  db: D1Database,
  id: number,
  patch: { status: "accepted" | "failed"; alpacaOrderId?: string; error?: string },
) {
  await db
    .prepare("UPDATE trades SET status = ?, alpaca_order_id = ?, error = ? WHERE id = ?")
    .bind(patch.status, patch.alpacaOrderId ?? null, patch.error ?? null, id)
    .run();
}

export async function recordSnapshotIfFirstToday(
  db: D1Database,
  date: string,
  equity: number,
  cash: number,
  spyClose: number | null,
) {
  await db
    .prepare("INSERT OR IGNORE INTO snapshots (date, equity, cash, spy_close) VALUES (?,?,?,?)")
    .bind(date, equity, cash, spyClose)
    .run();
}

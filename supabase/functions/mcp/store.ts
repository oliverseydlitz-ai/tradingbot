import type { GuardConfig } from "./guardrails.ts";

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
  source: "mcp" | "manual";
  reason: string;
  equity: number | null;
  error?: string | null;
}

/** Persistence port. The edge function uses the Postgres implementation in supabase-store.ts. */
export interface Store {
  /** MCP (Claude) orders that consume the daily cap: pending, accepted or canceled (rejections and manual orders don't count). */
  countOrdersToday(date: string): Promise<number>;
  insertTrade(date: string, t: TradeRow): Promise<number>;
  finishTrade(id: number, patch: { status: "accepted" | "failed"; alpacaOrderId?: string; error?: string }): Promise<void>;
  markCanceled(alpacaOrderId: string): Promise<void>;
  recordSnapshotIfFirstToday(date: string, equity: number, cash: number, spyClose: number | null): Promise<void>;
  listTrades(limit: number, symbol?: string): Promise<unknown[]>;
  /** Limits edited from the dashboard; null if never saved. */
  getSettings(): Promise<GuardConfig | null>;
  saveSettings(cfg: GuardConfig): Promise<void>;
}

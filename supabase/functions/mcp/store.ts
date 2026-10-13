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

export interface NoteInput {
  title?: string;
  body: string;
  tags: string[];
}

export interface ApprovalInput {
  symbol: string;
  side: "buy" | "sell";
  orderType: "market" | "limit";
  qty: number | null;
  notional: number | null;
  limitPrice: number | null;
  reason: string;
  estNotional: number;
  equity: number;
  expiresAt: string;
}

export interface ApprovalRow extends ApprovalInput {
  id: number;
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
  /** Claude's notes, kept so a later run can pick up where an earlier one left off. */
  saveNote(date: string, note: NoteInput): Promise<number>;
  listNotes(limit: number, tag?: string): Promise<unknown[]>;
  /** Big orders held for a Telegram Yes/No. */
  createApproval(a: ApprovalInput): Promise<number>;
  /** Atomically moves a still-pending, unexpired approval to approved/declined. Null if it was already decided or expired. */
  decideApproval(id: number, status: "approved" | "declined"): Promise<ApprovalRow | null>;
  finishApproval(id: number, patch: { status?: "failed"; result: string }): Promise<void>;
  /** Telegram portfolio report cadence, set on the dashboard. 0 = off. */
  getReportSchedule(): Promise<{ everyHours: number; lastAt: string | null }>;
  saveReportEvery(hours: number): Promise<void>;
  markReported(at: string): Promise<void>;
}

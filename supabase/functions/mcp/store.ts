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

export interface BotSettings {
  /** Portfolio update cadence in hours; 0 = off. */
  reportEveryHours: number;
  /** Claude orders at or above this % of equity wait for a Telegram Yes/No; 0 = never ask. */
  approvalPct: number;
  notifyClaudeTrades: boolean;
  notifyFills: boolean;
  /** Ping when a holding moves this much (%) in a day; 0 = off. */
  moverAlertPct: number;
  /** Kill switch: Claude's place_order is rejected while true. */
  claudePaused: boolean;
  lastReportAt: string | null;
  lastFillCheck: string | null;
  moversSent: { date: string; symbols: string[] } | null;
}

export const DEFAULT_BOT_SETTINGS: BotSettings = {
  reportEveryHours: 0,
  approvalPct: 5,
  notifyClaudeTrades: true,
  notifyFills: false,
  moverAlertPct: 0,
  claudePaused: false,
  lastReportAt: null,
  lastFillCheck: null,
  moversSent: null,
};

export interface PriceAlert {
  id: number;
  created_at: string;
  symbol: string;
  op: "above" | "below";
  price: number;
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
  /** Telegram bot settings (dashboard) plus the bot's own bookkeeping. */
  getBotSettings(): Promise<BotSettings>;
  patchBotSettings(patch: Partial<BotSettings>): Promise<void>;
  createAlert(a: { symbol: string; op: "above" | "below"; price: number }): Promise<number>;
  listAlerts(): Promise<PriceAlert[]>;
  /** Deactivates an active alert; false if there was none. */
  removeAlert(id: number): Promise<boolean>;
  markAlertTriggered(id: number, price: number): Promise<void>;
}

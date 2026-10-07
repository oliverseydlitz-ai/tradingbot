import { createClient } from "@supabase/supabase-js";
import type { GuardConfig } from "./guardrails.ts";
import type { Store, TradeRow } from "./store.ts";

const fail = (op: string, error: { message: string } | null) => {
  if (error) throw new Error(`db ${op}: ${error.message}`);
};

export function supabaseStore(url: string, serviceKey: string): Store {
  const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  return {
    async countOrdersToday(date) {
      const { count, error } = await db
        .from("trades")
        .select("id", { count: "exact", head: true })
        .eq("trade_date", date)
        .eq("source", "mcp")
        .in("status", ["pending", "accepted", "canceled"]);
      fail("count", error);
      return count ?? 0;
    },
    async insertTrade(date, t: TradeRow) {
      const { data, error } = await db
        .from("trades")
        .insert({
          trade_date: date,
          symbol: t.symbol,
          side: t.side,
          qty: t.qty,
          notional: t.notional,
          order_type: t.orderType,
          limit_price: t.limitPrice,
          status: t.status,
          source: t.source,
          reason: t.reason,
          equity_at_time: t.equity,
          error: t.error ?? null,
        })
        .select("id")
        .single();
      fail("insert", error);
      return data!.id as number;
    },
    async finishTrade(id, patch) {
      const { error } = await db
        .from("trades")
        .update({ status: patch.status, alpaca_order_id: patch.alpacaOrderId ?? null, error: patch.error ?? null })
        .eq("id", id);
      fail("finish", error);
    },
    async markCanceled(alpacaOrderId) {
      const { error } = await db
        .from("trades")
        .update({ status: "canceled" })
        .eq("alpaca_order_id", alpacaOrderId)
        .eq("status", "accepted");
      fail("cancel", error);
    },
    async recordSnapshotIfFirstToday(date, equity, cash, spyClose) {
      const { error } = await db
        .from("snapshots")
        .upsert({ date, equity, cash, spy_close: spyClose }, { onConflict: "date", ignoreDuplicates: true });
      fail("snapshot", error);
    },
    async listTrades(limit, symbol) {
      let q = db.from("trades").select("*").order("id", { ascending: false }).limit(limit);
      if (symbol) q = q.eq("symbol", symbol);
      const { data, error } = await q;
      fail("list", error);
      return data ?? [];
    },
    async getSettings() {
      const { data, error } = await db.from("settings").select("*").eq("id", 1).maybeSingle();
      fail("settings", error);
      if (!data) return null;
      return {
        maxOrderPct: data.max_order_pct,
        maxPositionPct: data.max_position_pct,
        maxOrdersPerDay: data.max_orders_per_day,
        allowlist: String(data.symbol_allowlist ?? "").split(",").map((x: string) => x.trim().toUpperCase()).filter(Boolean),
      } satisfies GuardConfig;
    },
    async saveSettings(cfg) {
      const { error } = await db.from("settings").upsert({
        id: 1,
        max_order_pct: cfg.maxOrderPct,
        max_position_pct: cfg.maxPositionPct,
        max_orders_per_day: cfg.maxOrdersPerDay,
        symbol_allowlist: cfg.allowlist.join(","),
        updated_at: new Date().toISOString(),
      });
      fail("save settings", error);
    },
  };
}

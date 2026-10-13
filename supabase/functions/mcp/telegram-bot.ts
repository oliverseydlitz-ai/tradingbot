import type { Alpaca } from "./alpaca.ts";
import type { GuardConfig } from "./guardrails.ts";
import { describeOrder, type OrderArgs, submitOrder } from "./order-service.ts";
import { nyDate, type Store } from "./store.ts";
import { esc, type Telegram } from "./telegram.ts";

export interface BotDeps {
  alpaca: Alpaca;
  store: Store;
  getCfg: () => Promise<GuardConfig>;
  telegram: Telegram;
}

const usd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signed = (n: number, s = usd(Math.abs(n))) => `${n >= 0 ? "+" : "−"}${s}`;
const pct = (n: number) => signed(n, `${Math.abs(n).toFixed(2)}%`);

export const HELP = [
  "<b>Commands</b>",
  "/portfolio – equity, day P&amp;L, cash and positions",
  "/buy 5 TSLA – buy 5 shares (market)",
  "/buy $500 TSLA – buy $500 worth",
  "/buy 5 TSLA @ 240 – limit order",
  "/sell 5 TSLA · /sell all TSLA",
  "/orders – open orders",
  "/note text – save a note Claude reads on its next run",
  "/notes – last 5 notes",
  "",
  "Trades from here use the same limits as the dashboard and are logged as manual.",
].join("\n");

export type ParsedTrade = { ok: true; symbol: string; qty?: number; notional?: number; all?: boolean; limit?: number } | { ok: false; error: string };

/** "5 TSLA", "TSLA 5", "$500 TSLA", "5 TSLA @ 240", "5 TSLA limit 240", "all TSLA". */
export function parseTrade(args: string): ParsedTrade {
  let rest = args.trim().replace(/,/g, "");
  let limit: number | undefined;
  const lm = /\s+(?:@|limit|at)\s*\$?(\d+(?:\.\d+)?)$/i.exec(rest);
  if (lm) {
    limit = Number(lm[1]);
    rest = rest.slice(0, lm.index).trim();
  }
  const parts = rest.split(/\s+/).filter(Boolean);
  if (parts.length !== 2) return { ok: false, error: "Use e.g. /buy 5 TSLA, /buy $500 TSLA or /buy 5 TSLA @ 240." };
  const isTicker = (s: string) => /^[A-Za-z]{1,5}(\.[A-Za-z])?$/.test(s) && !/^all$/i.test(s);
  const [a, b] = isTicker(parts[1]) ? [parts[0], parts[1]] : [parts[1], parts[0]];
  if (!isTicker(b)) return { ok: false, error: `"${b}" isn't a ticker.` };
  const symbol = b.toUpperCase();
  if (/^all$/i.test(a)) return limit ? { ok: false, error: "Use a share count with a limit price." } : { ok: true, symbol, all: true, limit };
  const dollars = a.startsWith("$");
  const n = Number(a.replace(/^\$/, ""));
  if (!Number.isFinite(n) || n <= 0) return { ok: false, error: `"${a}" isn't a size. Use shares (5) or dollars ($500).` };
  if (dollars && limit) return { ok: false, error: "Limit orders are sized in shares, not dollars." };
  return dollars ? { ok: true, symbol, notional: n } : { ok: true, symbol, qty: n, limit };
}

export async function portfolioReport(alpaca: Alpaca, title = "Portfolio"): Promise<string> {
  const [a, positions, clock] = await Promise.all([alpaca.getAccount(), alpaca.getPositions(), alpaca.getClock()]);
  const equity = Number(a.equity);
  const last = Number(a.last_equity);
  const day = equity - last;
  const rows = positions
    .map((p) => ({ s: p.symbol, mv: Number(p.market_value), plp: Number(p.unrealized_plpc) * 100, dayp: Number(p.unrealized_intraday_plpc ?? 0) * 100 }))
    .sort((x, y) => y.mv - x.mv);
  const lines = [
    `<b>${esc(title)}</b> · market ${clock.is_open ? "open" : "closed"}`,
    `Equity ${usd(equity)}  (${signed(day)}, ${pct(last ? (day / last) * 100 : 0)} today)`,
    `Cash ${usd(Number(a.cash))}`,
    "",
    ...(rows.length
      ? rows.map((r) => `<code>${esc(r.s.padEnd(5))}</code> ${usd(r.mv)} · ${(equity ? (r.mv / equity) * 100 : 0).toFixed(1)}% · ${pct(r.plp)} total, ${pct(r.dayp)} today`)
      : ["No positions."]),
  ];
  return lines.join("\n");
}

/** Handles a text message from your own chat. Returns the HTML reply. */
export async function handleCommand(text: string, d: BotDeps): Promise<string> {
  const m = /^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/.exec(text.trim());
  if (!m) return HELP;
  const cmd = m[1].toLowerCase();
  const args = m[2].trim();

  if (cmd === "start" || cmd === "help") return HELP;
  if (cmd === "portfolio" || cmd === "status") return portfolioReport(d.alpaca);

  if (cmd === "orders") {
    const os = await d.alpaca.getOrders("open", 20);
    if (!os.length) return "No open orders.";
    return ["<b>Open orders</b>", ...os.map((o) => esc(`${o.side.toUpperCase()} ${o.qty ?? `$${o.notional}`} ${o.symbol} · ${o.type}${o.limit_price ? ` @ ${o.limit_price}` : ""} · ${o.status}`))].join("\n");
  }

  if (cmd === "note") {
    if (!args) return "Usage: /note text. Claude reads it on its next run, and it shows on the dashboard.";
    if (args.length > 8000) return "Too long (8000 characters max).";
    const id = await d.store.saveNote(nyDate(), { title: "From Oliver (Telegram)", body: args, tags: ["telegram", "oliver"] });
    return `📝 Saved note #${id}. Claude sees it on its next run.`;
  }

  if (cmd === "notes") {
    const ns = (await d.store.listNotes(5)) as { id: number; note_date: string; title: string | null; body: string }[];
    if (!ns.length) return "No notes yet.";
    return ns.map((n) => `<b>#${n.id} · ${esc(n.note_date)}${n.title ? ` · ${esc(n.title)}` : ""}</b>\n${esc(n.body.length > 400 ? `${n.body.slice(0, 400)}…` : n.body)}`).join("\n\n");
  }

  if (cmd === "buy" || cmd === "sell") {
    const p = parseTrade(args);
    if (!p.ok) return esc(p.error);
    let qty = p.qty;
    if (p.all) {
      if (cmd === "buy") return "/buy all isn't a thing. Use shares or dollars.";
      const pos = (await d.alpaca.getPositions()).find((x) => x.symbol === p.symbol);
      if (!pos || !(Number(pos.qty) > 0)) return `You don't hold ${esc(p.symbol)}.`;
      qty = Number(pos.qty);
    }
    const order: OrderArgs = {
      symbol: p.symbol,
      side: cmd,
      order_type: p.limit ? "limit" : "market",
      qty,
      notional: p.notional,
      limit_price: p.limit,
      reason: `Telegram: ${text.trim().slice(0, 200)}`,
    };
    const r = await submitOrder({ alpaca: d.alpaca, store: d.store, cfg: await d.getCfg() }, order, "manual");
    if (!r.ok) return `⚠️ Not placed: ${esc(r.message)}`;
    return `✅ ${esc(describeOrder(order))} sent, ~${usd(r.data.estimated_notional)}. Status: ${esc(r.data.order.status)}.`;
  }

  return `Unknown command /${esc(cmd)}.\n\n${HELP}`;
}

export const REPORT_CHOICES = [0, 1, 4, 24, 168] as const;

/**
 * Called by the scheduler (pg_cron, every 15 minutes). Sends the portfolio report when one is due per the
 * dashboard setting. Hourly and 4-hourly reports only go out while the market is open; daily and weekly any time.
 */
export async function reportTick(d: BotDeps, now = new Date()): Promise<"off" | "not_due" | "market_closed" | "sent"> {
  const { everyHours, lastAt } = await d.store.getReportSchedule();
  if (!everyHours) return "off";
  const slackMs = 10 * 60_000; // ticks drift a few minutes; don't skip a whole interval over it
  if (lastAt && now.getTime() - Date.parse(lastAt) < everyHours * 3600_000 - slackMs) return "not_due";
  if (everyHours < 24 && !(await d.alpaca.getClock()).is_open) return "market_closed";
  const label = everyHours === 1 ? "Hourly update" : everyHours === 4 ? "4-hour update" : everyHours === 24 ? "Daily update" : "Weekly update";
  await d.telegram.send(await portfolioReport(d.alpaca, label));
  await d.store.markReported(now.toISOString());
  return "sent";
}

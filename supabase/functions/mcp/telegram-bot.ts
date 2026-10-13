import type { Alpaca } from "./alpaca.ts";
import type { GuardConfig } from "./guardrails.ts";
import { describeOrder, type OrderArgs, submitOrder } from "./order-service.ts";
import { type BotSettings, nyDate, type Store } from "./store.ts";
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
  "/perf – you vs SPY: today, ~1 week, 1 month",
  "/quote TSLA AAPL – latest prices",
  "/buy 5 TSLA – buy 5 shares (market)",
  "/buy $500 TSLA – buy $500 worth",
  "/buy 5 TSLA @ 240 – limit order",
  "/sell 5 TSLA · /sell all TSLA",
  "/orders – open orders",
  "/cancel TSLA · /cancel all – cancel open orders",
  "/alert TSLA &gt; 250 · /alert TSLA &lt; 200 – price alert",
  "/alerts · /unalert 3 – list / remove alerts",
  "/pause · /resume – stop / restart Claude's trading",
  "/settings – what the bot will message you about",
  "/note text – save a note Claude reads on its next run",
  "/notes – last 5 notes",
  "",
  "Trades from here use the same limits as the dashboard and are logged as manual. Notification settings live on the dashboard.",
].join("\n");

const TICKER = /^[A-Z]{1,5}(\.[A-Z])?$/;
const REPORT_LABEL: Record<number, string> = { 0: "off", 1: "hourly (market hours)", 4: "every 4 h (market hours)", 24: "daily", 168: "weekly" };

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

  if (cmd === "perf") return perfReport(d.alpaca);

  if (cmd === "quote" || cmd === "q") {
    const syms = [...new Set(args.toUpperCase().split(/[\s,]+/).filter(Boolean))];
    if (!syms.length || syms.length > 10 || syms.some((x) => !TICKER.test(x))) return "Usage: /quote TSLA [AAPL …] (up to 10).";
    const snaps = await d.alpaca.getSnapshots(syms);
    return syms
      .map((x) => {
        const sn = snaps[x];
        const last = sn?.latestTrade?.p ?? sn?.dailyBar?.c;
        const prev = sn?.prevDailyBar?.c;
        if (!last) return `<code>${esc(x.padEnd(5))}</code> no data`;
        return `<code>${esc(x.padEnd(5))}</code> ${usd(last)}${prev ? ` (${pct(((last - prev) / prev) * 100)} today)` : ""}`;
      })
      .join("\n");
  }

  if (cmd === "cancel") {
    const target = args.toUpperCase();
    if (!target || (target !== "ALL" && !TICKER.test(target))) return "Usage: /cancel TSLA (that symbol's open orders) or /cancel all.";
    const open = (await d.alpaca.getOrders("open", 100)).filter((o) => target === "ALL" || o.symbol === target);
    if (!open.length) return target === "ALL" ? "No open orders." : `No open orders for ${esc(target)}.`;
    const res = await Promise.allSettled(open.map(async (o) => (await d.alpaca.cancelOrder(o.id), await d.store.markCanceled(o.id).catch(() => {}))));
    const failed = res.filter((r) => r.status === "rejected").length;
    return `🗑 Canceled ${open.length - failed} order${open.length - failed === 1 ? "" : "s"}${failed ? `, ${failed} failed (maybe already filled)` : ""}.`;
  }

  if (cmd === "alert") {
    const am = /^([A-Za-z]{1,5}(?:\.[A-Za-z])?)\s*(>|<|>=|<=|above|below)\s*\$?(\d+(?:\.\d+)?)$/i.exec(args);
    if (!am) return "Usage: /alert TSLA &gt; 250 or /alert TSLA &lt; 200 (checked every few minutes while the market is open).";
    const symbol = am[1].toUpperCase();
    const op = am[2].startsWith(">") || am[2].toLowerCase() === "above" ? "above" : "below";
    const price = Number(am[3]);
    if (!(await d.alpaca.getAsset(symbol).catch(() => null))) return `${esc(symbol)} isn't a known ticker.`;
    if ((await d.store.listAlerts()).length >= 50) return "You already have 50 alerts. Remove some with /unalert.";
    const id = await d.store.createAlert({ symbol, op, price });
    return `🔔 Alert #${id}: ${esc(symbol)} ${op} ${usd(price)}.`;
  }

  if (cmd === "alerts") {
    const as = await d.store.listAlerts();
    if (!as.length) return "No active alerts. Add one with /alert TSLA &gt; 250.";
    return ["<b>Active alerts</b>", ...as.map((a) => `#${a.id} ${esc(a.symbol)} ${a.op} ${usd(a.price)}`)].join("\n");
  }

  if (cmd === "unalert") {
    const id = Number(args.replace(/^#/, ""));
    if (!Number.isInteger(id) || id <= 0) return "Usage: /unalert 3 (the number from /alerts).";
    return (await d.store.removeAlert(id)) ? `Removed alert #${id}.` : `No active alert #${id}.`;
  }

  if (cmd === "pause" || cmd === "resume") {
    await d.store.patchBotSettings({ claudePaused: cmd === "pause" });
    return cmd === "pause"
      ? "⏸ Claude's trading is paused. Its orders get rejected until you /resume. Your own trades still work."
      : "▶️ Claude can trade again.";
  }

  if (cmd === "settings") {
    const b = await d.store.getBotSettings();
    return [
      "<b>Bot settings</b> (change them on the dashboard)",
      `Claude trading: ${b.claudePaused ? "⏸ paused" : "on"}`,
      `Ask before Claude orders: ${b.approvalPct > 0 ? `≥ ${b.approvalPct}% of equity` : "never"}`,
      `Portfolio updates: ${REPORT_LABEL[b.reportEveryHours] ?? `every ${b.reportEveryHours} h`}`,
      `Claude trade pings: ${b.notifyClaudeTrades ? "on" : "off"}`,
      `Fill pings: ${b.notifyFills ? "on" : "off"}`,
      `Big mover pings: ${b.moverAlertPct > 0 ? `±${b.moverAlertPct}% in a day` : "off"}`,
    ].join("\n");
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

/** You vs SPY over today, ~1 week (5 sessions) and 1 month, from Alpaca's daily history plus live values. */
export async function perfReport(alpaca: Alpaca): Promise<string> {
  const [hist, bars, account, snaps] = await Promise.all([
    alpaca.getPortfolioHistory("1M"),
    alpaca.getDailyBars("SPY", 25),
    alpaca.getAccount(),
    alpaca.getSnapshots(["SPY"]),
  ]);
  const spyByDate = new Map(bars.map((b) => [b.date, b.c as number]));
  const today = nyDate();
  const rows = hist.timestamp
    .map((t, i) => ({ date: nyDate(new Date(t * 1000)), equity: hist.equity[i] ?? 0 }))
    .filter((r) => r.equity > 0 && spyByDate.has(r.date) && r.date < today)
    .map((r) => ({ ...r, spy: spyByDate.get(r.date)! }));
  const eqNow = Number(account.equity);
  const spyNow = snaps.SPY?.latestTrade?.p ?? snaps.SPY?.dailyBar?.c ?? null;
  const spyPrev = snaps.SPY?.prevDailyBar?.c ?? null;
  const ch = (now: number | null, then: number | null | undefined) => (now && then ? ((now - then) / then) * 100 : null);
  const line = (label: string, me: number | null, spy: number | null) =>
    me === null || spy === null ? `${label}: not enough history yet` : `${label}: you ${pct(me)} · SPY ${pct(spy)} · ${me >= spy ? "ahead" : "behind"} by ${(Math.abs(me - spy)).toFixed(2)} pts`;
  const wk = rows.length >= 5 ? rows[rows.length - 5] : undefined;
  const mo = rows[0];
  return [
    "<b>You vs SPY</b>",
    line("Today", ch(eqNow, Number(account.last_equity)), ch(spyNow, spyPrev)),
    line("~1 week", ch(eqNow, wk?.equity), ch(spyNow, wk?.spy)),
    line("1 month", ch(eqNow, mo?.equity), ch(spyNow, mo?.spy)),
  ].join("\n");
}

export const REPORT_CHOICES = [0, 1, 4, 24, 168] as const;

/** Dashboard-editable fields; the rest of BotSettings is the bot's own bookkeeping. */
export const EDITABLE_BOT_KEYS = ["reportEveryHours", "approvalPct", "notifyClaudeTrades", "notifyFills", "moverAlertPct", "claudePaused"] as const;
export type EditableBotSettings = Pick<BotSettings, (typeof EDITABLE_BOT_KEYS)[number]>;

export const publicBot = (b: BotSettings): EditableBotSettings => Object.fromEntries(EDITABLE_BOT_KEYS.map((k) => [k, b[k]])) as EditableBotSettings;

/** Validates a partial update from the dashboard. Unknown keys are ignored. */
export function validateBotSettings(input: unknown): { ok: true; patch: Partial<EditableBotSettings> } | { ok: false; error: string } {
  const o = (input ?? {}) as Record<string, unknown>;
  const patch: Partial<EditableBotSettings> = {};
  if (o.reportEveryHours !== undefined) {
    const n = Number(o.reportEveryHours);
    if (!(REPORT_CHOICES as readonly number[]).includes(n)) return { ok: false, error: "Portfolio updates must be off, hourly, every 4 hours, daily or weekly." };
    patch.reportEveryHours = n;
  }
  for (const [k, label] of [["approvalPct", "Approval threshold"], ["moverAlertPct", "Big mover threshold"]] as const) {
    if (o[k] === undefined) continue;
    const n = Number(o[k]);
    if (!Number.isFinite(n) || n < 0 || n > 100) return { ok: false, error: `${label} must be between 0 (off) and 100%.` };
    patch[k] = n;
  }
  for (const k of ["notifyClaudeTrades", "notifyFills", "claudePaused"] as const) {
    if (o[k] === undefined) continue;
    if (typeof o[k] !== "boolean") return { ok: false, error: `${k} must be true or false.` };
    patch[k] = o[k] as boolean;
  }
  return { ok: true, patch };
}

type JobResult = "off" | "not_due" | "market_closed" | "sent" | "none" | `error: ${string}`;

/**
 * Called by the scheduler (pg_cron, every 5 minutes). Runs each job independently so one failing doesn't stop the rest:
 * - portfolio update when due (hourly / 4-hourly only while the market is open; daily and weekly any time)
 * - price alerts (market open)
 * - big mover pings, once per symbol per day (market open)
 * - fill pings since the last check
 */
export async function reportTick(d: BotDeps, now = new Date()): Promise<Record<string, JobResult>> {
  const b = await d.store.getBotSettings();
  let clock: Promise<boolean> | null = null;
  const marketOpen = () => (clock ??= d.alpaca.getClock().then((c) => c.is_open));
  const run = async (fn: () => Promise<JobResult>): Promise<JobResult> => {
    try {
      return await fn();
    } catch (e) {
      console.error("tick job failed", (e as Error).message);
      return `error: ${(e as Error).message}`;
    }
  };

  const report = await run(async () => {
    if (!b.reportEveryHours) return "off";
    const slackMs = 4 * 60_000; // ticks drift a little; don't skip a whole interval over it
    if (b.lastReportAt && now.getTime() - Date.parse(b.lastReportAt) < b.reportEveryHours * 3600_000 - slackMs) return "not_due";
    if (b.reportEveryHours < 24 && !(await marketOpen())) return "market_closed";
    const label = b.reportEveryHours === 1 ? "Hourly update" : b.reportEveryHours === 4 ? "4-hour update" : b.reportEveryHours === 24 ? "Daily update" : "Weekly update";
    await d.telegram.send(await portfolioReport(d.alpaca, label));
    await d.store.patchBotSettings({ lastReportAt: now.toISOString() });
    return "sent";
  });

  const alerts = await run(async () => {
    const list = await d.store.listAlerts();
    if (!list.length) return "none";
    if (!(await marketOpen())) return "market_closed";
    const snaps = await d.alpaca.getSnapshots([...new Set(list.map((a) => a.symbol))]);
    let sent = 0;
    for (const a of list) {
      const p = snaps[a.symbol]?.latestTrade?.p;
      if (!p || !(a.op === "above" ? p >= a.price : p <= a.price)) continue;
      await d.store.markAlertTriggered(a.id, p);
      await d.telegram.send(`🔔 <b>${esc(a.symbol)} ${usd(p)}</b>, ${a.op} your ${usd(a.price)} alert (#${a.id}).`);
      sent++;
    }
    return sent ? "sent" : "none";
  });

  const movers = await run(async () => {
    if (!(b.moverAlertPct > 0)) return "off";
    if (!(await marketOpen())) return "market_closed";
    const date = nyDate(now);
    const already = b.moversSent?.date === date ? b.moversSent.symbols : [];
    const hits = (await d.alpaca.getPositions())
      .map((p) => ({ s: p.symbol, chg: Number(p.unrealized_intraday_plpc ?? 0) * 100, mv: Number(p.market_value) }))
      .filter((p) => Math.abs(p.chg) >= b.moverAlertPct && !already.includes(p.s));
    if (!hits.length) return "none";
    await d.telegram.send(
      [`📈 <b>Big moves today</b> (±${b.moverAlertPct}%)`, ...hits.map((h) => `<code>${esc(h.s.padEnd(5))}</code> ${pct(h.chg)} · ${usd(h.mv)}`)].join("\n"),
    );
    await d.store.patchBotSettings({ moversSent: { date, symbols: [...already, ...hits.map((h) => h.s)] } });
    return "sent";
  });

  const fills = await run(async () => {
    if (!b.notifyFills) return "off";
    // First run (or just switched on): start from now rather than replaying old fills.
    if (!b.lastFillCheck) {
      await d.store.patchBotSettings({ lastFillCheck: now.toISOString() });
      return "none";
    }
    const since = Date.parse(b.lastFillCheck);
    const fresh = (await d.alpaca.getOrders("closed", 50))
      .filter((o) => o.status === "filled" && o.filled_at && Date.parse(o.filled_at) > since)
      .reverse();
    if (!fresh.length) return "none";
    await d.telegram.send(
      [
        `✅ <b>Filled</b>`,
        ...fresh.map((o) => esc(`${o.side.toUpperCase()} ${Number(o.filled_qty)} ${o.symbol} @ ${usd(Number(o.filled_avg_price))}`)),
      ].join("\n"),
    );
    const latest = Math.max(...fresh.map((o) => Date.parse(o.filled_at!)));
    await d.store.patchBotSettings({ lastFillCheck: new Date(latest).toISOString() });
    return "sent";
  });

  return { report, alerts, movers, fills };
}

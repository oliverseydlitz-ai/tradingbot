import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, ALLOWED_GITHUB_LOGIN } from "/config.js";

const API = `${SUPABASE_URL}/functions/v1/mcp/api`;
const sb = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
const root = document.getElementById("app");
const finePointer = matchMedia("(pointer: fine)").matches;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------- formatting ---------- */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const MINUS = "−";
const sign = (n) => (n > 0 ? "+" : n < 0 ? MINUS : "");
const tone = (n) => (n > 0.00001 ? "gain" : n < -0.00001 ? "loss" : "flat");
const usd = (n, d = 2) =>
  (n < 0 ? MINUS : "") + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const usdShort = (n) => (Math.abs(n) >= 1000 ? usd(n, 0) : usd(n));
const pct = (n, d = 2) => `${sign(n)}${Math.abs(n).toFixed(d)}%`;
const pts = (n) => `${sign(n)}${Math.abs(n).toFixed(2)} pts`;
const shares = (q) => q.toLocaleString("en-US", { maximumFractionDigits: 4 });
const dayFmt = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const fmtDay = (ymd) => dayFmt.format(new Date(`${ymd}T12:00:00Z`));
function relTime(iso) {
  const t = new Date(iso).getTime(), s = (Date.now() - t) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function untilText(iso) {
  const m = Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}
const opensText = (iso) =>
  new Date(iso).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" });

/* Guardrail codes come back as "RULE: message" (log) or "REJECTED by guardrail RULE: message" (order). */
const RULES = {
  MARKET_CLOSED: "Market is closed", MAX_ORDER_PCT: "Over your max order size", MAX_POSITION_PCT: "Over your max position size",
  MAX_ORDERS_PER_DAY: "Daily order limit reached", NO_SHORTING: "Not enough shares to sell", NO_MARGIN: "Not enough cash",
  ASSET_CLASS: "Not a US stock or ETF", SYMBOL_ALLOWLIST: "Not on your allowlist", UNKNOWN_SYMBOL: "Unknown ticker",
  NOT_TRADABLE: "Not tradable right now", NOT_FRACTIONABLE: "Whole shares only", NO_PRICE: "No price available",
  SIZE_INPUT: "Check the order size", LIMIT_PRICE: "Check the limit price", ACCOUNT_BLOCKED: "Account is blocked",
};
function explain(raw) {
  const m = /^(?:REJECTED by guardrail )?([A-Z_]+): ([\s\S]*)$/.exec(String(raw ?? ""));
  return m && RULES[m[1]] ? { title: RULES[m[1]], detail: m[2] } : { title: null, detail: String(raw ?? "") };
}
const alertHtml = (raw) => {
  const e = explain(raw);
  return `<div class="alert err">${e.title ? `<b>${esc(e.title)}.</b> ` : ""}${esc(e.detail)}</div>`;
};

/* ---------- icons (hand-drawn, 24px grid) ---------- */
const I = {
  mark: `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M3 17l5-4.5 3.5 2L18 7l3 1.5" stroke="var(--accent)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 20.5l18-5" stroke="var(--mute)" stroke-width="1.4" stroke-dasharray="1.5 2.5" stroke-linecap="round"/></svg>`,
  up: `<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 2.5l3.8 6H2.2z" fill="currentColor"/></svg>`,
  down: `<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 9.5l3.8-6H2.2z" fill="currentColor"/></svg>`,
  refresh: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v4.5h-4.5"/></svg>`,
  sliders: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2.2"/><circle cx="8" cy="17" r="2.2"/></svg>`,
  close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>`,
  buy: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 12.5v-9M4 7.5l4-4 4 4"/></svg>`,
  sell: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3.5v9M4 8.5l4 4 4-4"/></svg>`,
  note: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 13l1-3.5L10.5 3a1.4 1.4 0 0 1 2 2L6 11.5z"/><path d="M9.5 4l2 2"/></svg>`,
  block: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="M4.2 11.8l7.6-7.6"/></svg>`,
  github: `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`,
};
const deltaChip = (v, text) =>
  `<span class="chip ${tone(v)}">${v > 0.00001 ? I.up : v < -0.00001 ? I.down : ""}${text}</span>`;

/* ---------- state ---------- */
const S = {
  login: "",
  data: null,
  trades: [],
  notes: [],
  history: {},
  period: "1M",
  feed: null,
  animateChart: true,
  firstPaint: true,
  scrubbing: false,
  sheet: null,
};
const T = { symbol: "", side: "buy", size: "notional", type: "market", amount: "", limit: "", note: "", quote: null, review: false, busy: false, error: null };

async function api(path, opts = {}) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { location.reload(); throw new Error("Signed out"); }
  const res = await fetch(API + path, { ...opts, headers: { authorization: `Bearer ${session.access_token}`, "content-type": "application/json" } });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) { await sb.auth.signOut(); location.reload(); }
  return { status: res.status, body };
}

/* ---------- sign-in ---------- */
function renderGate(note) {
  root.innerHTML = `<main class="gate">
    <div class="mark">${I.mark}<span>Portfolio</span></div>
    <div class="gate-art">
      <h1>Claude <em>vs.</em><br>the market.</h1>
      <p>A paper-trading experiment. One model, one account, one benchmark: the S&amp;P 500.</p>
      <svg class="squiggle" viewBox="0 0 400 120" preserveAspectRatio="none" aria-hidden="true">
        <path d="M0 96 C40 92 60 70 95 74 S150 98 185 80 S240 40 275 46 S330 22 400 12" fill="none" stroke="var(--accent)" stroke-width="2.4" stroke-linecap="round" pathLength="1" style="stroke-dasharray:1;stroke-dashoffset:1;animation:draw 1.6s var(--ease) .2s forwards"/>
        <path d="M0 104 C60 100 120 90 200 78 S320 58 400 50" fill="none" stroke="var(--spy)" stroke-width="1.6" stroke-dasharray="4 6" stroke-linecap="round" opacity=".7"/>
      </svg>
    </div>
    <div>
      ${note ? `<div class="alert err" style="margin:0 0 12px">${esc(note)}</div>` : ""}
      <button class="btn gh" id="login" style="margin:0">${I.github}<span>Continue with GitHub</span></button>
      <p class="hint" style="text-align:center">Private dashboard. One account only.</p>
    </div>
  </main>`;
  document.getElementById("login").onclick = () =>
    sb.auth.signInWithOAuth({ provider: "github", options: { redirectTo: location.origin + "/" } });
}

/* ---------- shell (persistent: sheets, fab, toast survive re-renders) ---------- */
function mountShell() {
  root.innerHTML = `<div class="shell" id="main"></div>
    <button class="fab" id="fab" aria-label="New trade">${I.plus}<span>Trade</span></button>
    <div class="scrim" id="scrim"></div>
    <section class="sheet" id="sheet-trade" role="dialog" aria-modal="true" aria-labelledby="t-title"></section>
    <section class="sheet" id="sheet-limits" role="dialog" aria-modal="true" aria-labelledby="l-title"></section>
    <div class="toast" id="toast" role="status" aria-live="polite"></div>`;
  document.getElementById("fab").onclick = () => openTrade();
  document.getElementById("scrim").onclick = closeSheet;
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && S.sheet) closeSheet(); });
}

let toastTimer;
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("on"), 3200);
}

/* ---------- main view ---------- */
function marketBits(m) {
  return m.is_open
    ? { cls: "open", chip: "Open", line: `Market closes in ${untilText(m.next_close)}` }
    : { cls: "", chip: "Closed", line: `Market opens ${opensText(m.next_open)}` };
}

function heroHtml(d) {
  const a = d.account;
  const [whole, cents] = usd(a.equity).split(".");
  const mk = marketBits(d.market);
  return `<section class="hero">
    <div class="eyebrow">Paper equity</div>
    <div class="equity num" id="equity" data-v="${a.equity}">${whole}<span class="cents">.${cents}</span></div>
    <div class="delta">${deltaChip(a.day_pl, `${sign(a.day_pl)}${usd(Math.abs(a.day_pl))}`)}<span class="${tone(a.day_pl) === "flat" ? "mute" : tone(a.day_pl)}">${pct(a.day_pl_pct)}</span><span class="mute">today</span></div>
    <div class="hint" style="margin-top:12px">${esc(mk.line)}</div>
  </section>`;
}

function tapeHtml(d) {
  if (!d.positions.length) return "";
  const items = [...d.positions].sort((a, b) => a.symbol.localeCompare(b.symbol))
    .map((p) => `<span class="tape-item"><b>${esc(p.symbol)}</b><span class="num">${usd(p.current_price)}</span><span class="${tone(p.day_pl_pct)} num">${pct(p.day_pl_pct)}</span></span>`).join("");
  const dur = Math.max(18, d.positions.length * 5);
  return `<div class="tape" aria-hidden="true"><div class="tape-track" style="animation-duration:${dur}s">${items}${items}</div></div>`;
}

function scoreHtml() {
  const p = S.history.all ?? [];
  if (p.length < 2) {
    return `<section class="card score"><div class="card-h"><h2>The race</h2><span class="aside">vs S&amp;P 500</span></div>
      <div class="vs"><div class="side"><div class="who"><i></i>Claude</div><div class="ret num">0.00%</div></div><div class="vs-mid">vs</div><div class="side spy"><div class="who"><i></i>SPY</div><div class="ret num">0.00%</div></div></div>
      <div class="verdict"><span><strong>Day one.</strong> The scoreboard starts after the first full trading day.</span></div></section>`;
  }
  const last = p.at(-1), c = last.portfolio - 100, s = last.spy - 100, lead = c - s;
  const half = Math.min(Math.abs(lead) / Math.max(3, Math.abs(lead) * 1.15), 1) * 50;
  // Tug of war: the bar pulls toward whoever leads (Claude on the left, SPY on the right).
  const bar = lead >= 0
    ? `<b style="left:${50 - half}%;width:${half}%;background:var(--accent)"></b>`
    : `<b style="left:50%;width:${half}%;background:var(--spy)"></b>`;
  const verdict = Math.abs(lead) < 0.005 ? "<strong>Dead even.</strong>"
    : lead > 0 ? `<strong>Claude leads</strong> by ${pts(lead).slice(1)}` : `<strong>SPY leads</strong> by ${pts(-lead).slice(1)}`;
  return `<section class="card score"><div class="card-h"><h2>The race</h2><span class="aside">since ${esc(fmtDay(p[0].date))} · ${p.length - 1} trading day${p.length === 2 ? "" : "s"}</span></div>
    <div class="vs">
      <div class="side"><div class="who"><i></i>Claude</div><div class="ret num ${tone(c)}">${pct(c)}</div></div>
      <div class="vs-mid">vs</div>
      <div class="side spy"><div class="who"><i></i>SPY</div><div class="ret num ${tone(s)}">${pct(s)}</div></div>
    </div>
    <div class="race" role="img" aria-label="Lead ${esc(pts(lead))}">${bar}</div>
    <div class="verdict"><span>${verdict}</span></div>
  </section>`;
}

function chartCardHtml() {
  const p = S.history[S.period] ?? [];
  const periods = [["1W", "1W"], ["1M", "1M"], ["3M", "3M"], ["6M", "6M"], ["1A", "1Y"], ["all", "All"]];
  const body = p.length < 2
    ? `<div class="plot-empty"><div><b>Building history</b>The curve appears once the account has two trading days on record.</div></div>`
    : `<div class="plot" id="plot"></div>`;
  return `<section class="card chart-card">
    <div class="card-h"><h2>Return vs benchmark</h2><span class="aside">indexed to 0%</span></div>
    <div class="readout" aria-live="off">
      <div class="r"><span class="k"><i></i>Claude</span><span class="v num" id="ro-p">–</span></div>
      <div class="r"><span class="k"><i class="d"></i>SPY</span><span class="v num" id="ro-s">–</span></div>
      <span class="when" id="ro-w"></span>
    </div>
    ${body}
    <div class="tabs" role="group" aria-label="Period">${periods.map(([k, l]) => `<button data-period="${k}" aria-pressed="${k === S.period}">${l}</button>`).join("")}</div>
  </section>`;
}

function allocationHtml(d) {
  const colors = ["var(--cat-1)", "var(--cat-2)", "var(--cat-3)", "var(--cat-cash)"];
  const total = d.allocation.reduce((s, a) => s + a.value, 0) || 1;
  return `<section class="card"><div class="card-h"><h2>Allocation</h2><span class="aside">${d.positions.length} position${d.positions.length === 1 ? "" : "s"}</span></div>
    <div class="alloc-bar" role="img" aria-label="${esc(d.allocation.map((a) => `${a.label} ${((a.value / total) * 100).toFixed(1)}%`).join(", "))}">
      ${d.allocation.map((a, i) => (a.value > 0.5 ? `<i style="flex:${a.value};background:${colors[i]};animation-delay:${i * 80}ms"></i>` : "")).join("")}
    </div>
    <div class="legend">${d.allocation.map((a, i) => `<div><i style="background:${colors[i]}"></i><span class="l">${esc(a.label)}</span><span class="p">${((a.value / total) * 100).toFixed(1)}%<small>${usdShort(a.value)}</small></span></div>`).join("")}</div>
  </section>`;
}

function performanceHtml(d) {
  const rows = [...d.positions].sort((a, b) => b.unrealized_pl_pct - a.unrealized_pl_pct);
  if (!rows.length) return "";
  const max = Math.max(0.5, ...rows.map((r) => Math.abs(r.unrealized_pl_pct)));
  return `<section class="card"><div class="card-h"><h2>Best to worst</h2><span class="aside">return since entry</span></div>
    <div class="perf">${rows.map((r, i) => {
      const w = (Math.abs(r.unrealized_pl_pct) / max) * 50, pos = r.unrealized_pl_pct >= 0;
      return `<div class="perf-row"><span class="s">${esc(r.symbol)}</span>
        <span class="t"><b style="${pos ? `left:50%` : `left:${50 - w}%`};width:${Math.max(w, 0.6)}%;background:${pos ? "var(--gain)" : "var(--loss)"};--o:${pos ? "left" : "right"};animation-delay:${i * 40}ms"></b></span>
        <span class="v ${tone(r.unrealized_pl_pct)}">${pct(r.unrealized_pl_pct)}</span></div>`;
    }).join("")}</div>
    <div class="perf-scale"><span>${MINUS}${max.toFixed(1)}%</span><span>0</span><span>+${max.toFixed(1)}%</span></div>
  </section>`;
}

function holdingsHtml(d) {
  const rows = [...d.positions].sort((a, b) => b.market_value - a.market_value);
  const maxW = Math.max(1, ...rows.map((r) => r.weight_pct));
  return `<section class="card"><div class="card-h"><h2>Holdings</h2><span class="aside">tap to trade</span></div>
    ${rows.length ? `<div class="holdings">${rows.map((p) => `<button class="h-row" data-sym="${esc(p.symbol)}" aria-label="Trade ${esc(p.symbol)}">
      <span class="h-sym"><b>${esc(p.symbol)}</b><span>${esc(p.name)}</span></span>
      <span class="h-val">${usd(p.market_value)}</span>
      <span class="h-sub"><span class="w"><i style="width:${(p.weight_pct / maxW) * 100}%"></i></span>${p.weight_pct.toFixed(1)}% · ${shares(p.qty)} sh</span>
      <span class="h-pl"><span class="${tone(p.unrealized_pl)}">${sign(p.unrealized_pl)}${usd(Math.abs(p.unrealized_pl))} (${pct(p.unrealized_pl_pct)})</span></span>
    </button>`).join("")}</div>` : `<p class="empty">No positions yet. Claude's first run, or a tap on Trade, fills this in.</p>`}
  </section>`;
}

function openOrdersHtml(d) {
  if (!d.open_orders.length) return "";
  return `<section class="card"><div class="card-h"><h2>Working orders</h2><span class="aside">${d.open_orders.length}</span></div>
    ${d.open_orders.map((o) => `<div class="order"><span><b>${esc(o.side.toUpperCase())} ${esc(o.symbol)}</b> <span class="mute">${o.qty ? `${shares(o.qty)} sh` : usd(o.notional)} · ${esc(o.type)}${o.limit_price ? ` @ ${usd(o.limit_price)}` : ""}</span></span>
      <button class="chip flat" style="border:0" data-cancel="${esc(o.id)}">Cancel</button></div>`).join("")}
  </section>`;
}

function tradeEvent(t) {
  const amt = t.notional ? usd(t.notional, t.notional % 1 ? 2 : 0) : `${shares(Number(t.qty))} sh`;
  const verb = t.side === "buy" ? "Buy" : "Sell";
  const titles = {
    accepted: t.order_type === "limit" ? `Limit ${verb.toLowerCase()} placed` : t.side === "buy" ? "Bought" : "Sold",
    pending: `${verb} pending`, rejected: `${verb} blocked`, failed: `${verb} failed`, canceled: `${verb} canceled`,
  };
  const blocked = t.status === "rejected" || t.status === "failed";
  const long = (t.reason ?? "").length > 220;
  return `<article class="ev">
    <span class="ev-dot ${blocked ? "" : t.side}">${blocked ? I.block : I[t.side] ?? I.buy}</span>
    <div><div class="ev-top"><span class="ev-title">${esc(titles[t.status] ?? t.status)} <span class="mono">${esc(t.symbol)}</span> <span class="mute num">${amt}</span></span><time class="ev-time" datetime="${esc(t.created_at)}">${esc(relTime(t.created_at))}</time></div>
      <div class="ev-tags">${t.source === "manual" ? `<span class="tag">You</span>` : `<span class="tag ai">Claude</span>`}${blocked ? `<span class="tag warn">${esc(explain(t.error).title ?? (t.status === "rejected" ? "Guardrail" : "Error"))}</span>` : ""}</div>
      ${t.reason ? `<div class="ev-body${long ? " clamp" : ""}">${esc(t.reason)}</div>${long ? `<button class="more">Read more</button>` : ""}` : ""}
      ${t.error ? `<div class="ev-err">${esc(explain(t.error).detail)}</div>` : ""}
    </div></article>`;
}

function noteEvent(n) {
  const long = n.body.length > 260 || n.body.split("\n").length > 4;
  return `<article class="ev">
    <span class="ev-dot note">${I.note}</span>
    <div><div class="ev-top"><span class="ev-title">${esc(n.title || "Note")}</span><time class="ev-time" datetime="${esc(n.created_at)}">${esc(relTime(n.created_at))}</time></div>
      ${(n.tags ?? []).length ? `<div class="ev-tags">${n.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>` : ""}
      <div class="ev-body${long ? " clamp" : ""}">${esc(n.body)}</div>${long ? `<button class="more">Read more</button>` : ""}
    </div></article>`;
}

function feedHtml() {
  const tab = S.feed ?? (S.notes.length ? "journal" : "trades");
  const list = tab === "journal"
    ? (S.notes.length ? S.notes.map(noteEvent).join("") : `<p class="empty">Claude hasn't written a note yet. Each scheduled run ends with one.</p>`)
    : (S.trades.length ? S.trades.map(tradeEvent).join("") : `<p class="empty">No trades yet.</p>`);
  return `<section class="card"><div class="card-h" style="align-items:center"><h2>${tab === "journal" ? "Claude's journal" : "Trade log"}</h2>
      <div class="seg" role="group" aria-label="Feed"><button data-feed="journal" aria-pressed="${tab === "journal"}">Journal</button><button data-feed="trades" aria-pressed="${tab === "trades"}">Trades</button></div></div>
    <div class="feed">${list}</div></section>`;
}

function renderMain() {
  const d = S.data;
  const mk = marketBits(d.market);
  const main = document.getElementById("main");
  main.innerHTML = `
    <header class="bar">
      <div class="mark">${I.mark}<span>Portfolio</span></div>
      <div class="bar-right">
        <span class="status ${mk.cls}" title="${esc(mk.line)}"><i></i>${mk.chip}</span>
        <button class="icon-btn" id="refresh" aria-label="Refresh">${I.refresh}</button>
        <button class="icon-btn" id="limits" aria-label="Limits and account">${I.sliders}</button>
        <button class="bar-trade" id="bar-trade">${I.plus}<span>Trade</span></button>
      </div>
    </header>
    ${tapeHtml(d)}
    <div class="top">${heroHtml(d)}${scoreHtml()}</div>
    <div class="grid">
      <div class="col">${chartCardHtml()}${holdingsHtml(d)}${openOrdersHtml(d)}</div>
      <div class="col">${allocationHtml(d)}${performanceHtml(d)}${feedHtml()}</div>
    </div>
    <footer class="foot"><span>Alpaca paper account · IEX data</span><span>Signed in as ${esc(S.login)}</span></footer>`;
  if (!S.firstPaint) main.classList.add("settled");
  mountChart();
  if (S.firstPaint) countUp();
  S.firstPaint = false;
}

function countUp() {
  const el = document.getElementById("equity");
  if (!el || reducedMotion) return;
  const target = Number(el.dataset.v), from = target * 0.985, t0 = performance.now(), dur = 900;
  const step = (now) => {
    const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
    const [w, c] = usd(from + (target - from) * e).split(".");
    el.innerHTML = `${w}<span class="cents">.${c}</span>`;
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/* ---------- chart ---------- */
function niceStep(range) {
  const raw = range / 3, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
}

function mountChart() {
  const el = document.getElementById("plot");
  const points = S.history[S.period] ?? [];
  const setReadout = (p, label) => {
    const rp = document.getElementById("ro-p"), rs = document.getElementById("ro-s"), rw = document.getElementById("ro-w");
    if (!rp) return;
    if (!p) { rp.textContent = "–"; rs.textContent = "–"; rw.textContent = ""; return; }
    rp.textContent = pct(p.portfolio - 100); rp.className = `v num ${tone(p.portfolio - 100)}`;
    rs.textContent = pct(p.spy - 100); rs.className = `v num ${tone(p.spy - 100)}`;
    rw.textContent = label;
  };
  const periodLabel = points.length ? `${fmtDay(points[0].date)} – ${fmtDay(points.at(-1).date)}` : "";
  setReadout(points.at(-1), periodLabel);
  if (!el || points.length < 2) return;

  const W = el.clientWidth, H = el.clientHeight, padT = 12, padB = 26, padR = 50, padL = 18;
  const vals = points.flatMap((p) => [p.portfolio - 100, p.spy - 100]).concat(0);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const span = Math.max(hi - lo, 0.4);
  lo -= span * 0.12; hi += span * 0.12;
  const n = points.length;
  const x = (i) => padL + (i / (n - 1)) * (W - padL - padR);
  const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
  const line = (k) => points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p[k] - 100).toFixed(1)}`).join("");
  const step = niceStep(hi - lo);
  const ticks = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) ticks.push(+v.toFixed(6));
  const xl = [0, Math.floor((n - 1) / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i);
  const gid = `g${Math.random().toString(36).slice(2, 7)}`;

  el.classList.toggle("anim", S.animateChart && !reducedMotion);
  el.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="Claude ${esc(pct(points.at(-1).portfolio - 100))} versus SPY ${esc(pct(points.at(-1).spy - 100))} over the period">
    <defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--accent)" stop-opacity=".26"/><stop offset="1" stop-color="var(--accent)" stop-opacity="0"/></linearGradient></defs>
    ${ticks.map((v) => `<line x1="${padL}" x2="${W - padR + 6}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" ${v === 0 ? "" : 'stroke-dasharray="2 4"'}/><text x="${W - 2}" y="${y(v) + 3.5}" text-anchor="end" font-size="10" font-family="var(--mono)" fill="var(--mute)">${v === 0 ? "0%" : pct(v, step < 0.1 ? 2 : step < 1 ? 1 : 0)}</text>`).join("")}
    <path class="fade" d="${line("portfolio")}L${x(n - 1)} ${H - padB}L${x(0)} ${H - padB}Z" fill="url(#${gid})"/>
    <path class="fade" d="${line("spy")}" fill="none" stroke="var(--spy)" stroke-width="1.5" stroke-dasharray="4 4" stroke-linejoin="round" opacity=".85"/>
    <path class="draw" d="${line("portfolio")}" fill="none" stroke="var(--accent)" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle class="fade" cx="${x(n - 1)}" cy="${y(points.at(-1).portfolio - 100)}" r="3.5" fill="var(--accent)"/>
    ${xl.map((i, k) => `<text x="${x(i)}" y="${H - 6}" font-size="10" font-family="var(--mono)" fill="var(--mute)" text-anchor="${k === 0 ? "start" : k === xl.length - 1 ? "end" : "middle"}">${esc(fmtDay(points[i].date))}</text>`).join("")}
    <g id="xh" style="display:none"><line y1="${padT}" y2="${H - padB}" stroke="var(--ink-2)" stroke-width="1" opacity=".5"/><circle r="4.5" fill="var(--accent)" stroke="var(--surface)" stroke-width="2"/><circle r="4" fill="var(--spy)" stroke="var(--surface)" stroke-width="2"/></g>
  </svg>`;
  // The line-draw animation needs the path's real length.
  el.querySelectorAll("path.draw").forEach((p) => p.style.setProperty("--len", Math.ceil(p.getTotalLength())));
  S.animateChart = false;

  const xh = el.querySelector("#xh"), [vl, c1, c2] = xh.children;
  const scrub = (ev) => {
    const r = el.getBoundingClientRect();
    const i = Math.max(0, Math.min(n - 1, Math.round(((ev.clientX - r.left - padL) / (W - padL - padR)) * (n - 1))));
    const p = points[i], cx = x(i);
    xh.style.display = "";
    vl.setAttribute("x1", cx); vl.setAttribute("x2", cx);
    c1.setAttribute("cx", cx); c1.setAttribute("cy", y(p.portfolio - 100));
    c2.setAttribute("cx", cx); c2.setAttribute("cy", y(p.spy - 100));
    setReadout(p, `${fmtDay(p.date)} · ${usd(p.equity, 0)}`);
    S.scrubbing = true;
  };
  const end = () => { xh.style.display = "none"; setReadout(points.at(-1), periodLabel); S.scrubbing = false; };
  el.onpointermove = scrub;
  el.onpointerdown = scrub;
  el.onpointerleave = end;
  el.onpointerup = (e) => { if (e.pointerType !== "mouse") end(); };
  el.onpointercancel = end;
}

/* ---------- sheets ---------- */
let lastFocus = null;
function openSheet(id) {
  lastFocus = document.activeElement;
  S.sheet = id;
  document.getElementById("scrim").classList.add("on");
  document.getElementById(id).classList.add("on");
  document.body.style.overflow = "hidden";
}
function closeSheet() {
  if (!S.sheet) return;
  document.getElementById(S.sheet).classList.remove("on");
  document.getElementById("scrim").classList.remove("on");
  document.body.style.overflow = "";
  S.sheet = null;
  lastFocus?.focus?.();
}

/* trade ticket */
const position = (sym) => S.data?.positions.find((p) => p.symbol === sym);
const estPrice = () => {
  const q = T.quote;
  if (T.type === "limit" && Number(T.limit) > 0) return Number(T.limit);
  if (!q || q.error) return null;
  return (T.side === "buy" ? q.ask : q.bid) || q.last || null;
};

function openTrade(symbol = "") {
  Object.assign(T, { symbol, side: "buy", size: "notional", type: "market", amount: "", limit: "", note: "", quote: null, review: false, busy: false, error: null });
  const el = document.getElementById("sheet-trade");
  el.innerHTML = `<div class="grab"></div>
    <div class="sheet-h"><h3 id="t-title">New trade</h3><button class="icon-btn" data-close aria-label="Close">${I.close}</button></div>
    <div class="field"><label for="t-sym">Symbol</label><input class="input sym" id="t-sym" value="${esc(symbol)}" placeholder="SPY" maxlength="7" autocomplete="off" autocapitalize="characters" spellcheck="false" inputmode="text"><div id="t-quote"></div></div>
    <div class="field"><div class="side-toggle" role="group" aria-label="Side"><button class="b" data-side="buy" aria-pressed="true">Buy</button><button class="s" data-side="sell" aria-pressed="false">Sell</button></div></div>
    <div class="field"><div class="row2">
      <div><span class="lbl">Size in</span><div class="mini-seg" role="group" aria-label="Size in"><button data-size="notional" aria-pressed="true">Dollars</button><button data-size="qty" aria-pressed="false">Shares</button></div></div>
      <div><span class="lbl">Order</span><div class="mini-seg" role="group" aria-label="Order type"><button data-type="market" aria-pressed="true">Market</button><button data-type="limit" aria-pressed="false">Limit</button></div></div>
    </div></div>
    <div class="field"><label for="t-amt" id="t-amt-l">Amount</label><div class="affix"><span class="pre" id="t-pre">$</span><input class="input big" id="t-amt" inputmode="decimal" placeholder="0" autocomplete="off"></div><div class="chips" id="t-chips"></div></div>
    <div class="field" id="t-lim-f" hidden><label for="t-lim">Limit price</label><div class="affix"><span class="pre">$</span><input class="input big" id="t-lim" inputmode="decimal" placeholder="0.00" autocomplete="off"></div></div>
    <div class="field"><label for="t-note">Note <span style="text-transform:none;letter-spacing:0">(optional, logged)</span></label><input class="input" id="t-note" maxlength="500" placeholder="Why this trade?" autocomplete="off"></div>
    <div id="t-review"></div>`;
  openSheet("sheet-trade");
  wireTrade(el);
  refreshTicket();
  if (symbol) fetchQuote();
  if (finePointer) (symbol ? el.querySelector("#t-amt") : el.querySelector("#t-sym")).focus();
}

let quoteTimer;
async function fetchQuote() {
  const sym = T.symbol;
  if (!/^[A-Z]{1,5}(\.[A-Z])?$/.test(sym)) { T.quote = null; return refreshTicket(); }
  const box = document.getElementById("t-quote");
  if (box) box.innerHTML = `<div class="quote"><span class="n">Looking up ${esc(sym)}…</span></div>`;
  const r = await api(`/quote?symbol=${encodeURIComponent(sym)}`);
  if (sym !== T.symbol) return; // user kept typing
  T.quote = r.status === 200 ? r.body : { error: r.body.error || `${sym} not found` };
  refreshTicket();
}

function chipsFor() {
  const pos = position(T.symbol);
  if (T.side === "sell") {
    if (!pos) return T.symbol && T.quote && !T.quote.error ? `<span class="hint" style="margin:4px 0 0">You don't hold ${esc(T.symbol)}. Selling needs an existing position.</span>` : "";
    return [["25%", 0.25], ["50%", 0.5], ["All", 1]].map(([l, f]) => `<button data-frac="${f}">${l} · ${shares(pos.qty * f)} sh</button>`).join("");
  }
  return T.size === "notional"
    ? [250, 1000, 2500, 5000].map((v) => `<button data-amt="${v}">${usd(v, 0)}</button>`).join("")
    : [1, 5, 10, 25].map((v) => `<button data-amt="${v}">${v} sh</button>`).join("");
}

function refreshTicket() {
  const el = document.getElementById("sheet-trade");
  if (!el || !S.sheet) return;
  const q = T.quote, pos = position(T.symbol);
  const qb = el.querySelector("#t-quote");
  qb.innerHTML = !q ? "" : q.error ? `<div class="quote"><span class="n loss">${esc(q.error)}</span></div>`
    : `<div class="quote"><span class="n">${esc(q.name)}</span><span class="p">${q.last ? usd(q.last) : "–"}</span>
       <span class="m">${esc(q.category)} · bid ${q.bid ? usd(q.bid) : "–"} · ask ${q.ask ? usd(q.ask) : "–"}${pos ? ` · you hold ${shares(pos.qty)} sh` : ""}${q.tradable ? "" : ` · <span class="loss">not tradable here</span>`}</span></div>`;
  el.querySelectorAll("[data-side]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.side === T.side));
  el.querySelectorAll("[data-size]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.size === T.size));
  el.querySelectorAll("[data-type]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.type === T.type));
  el.querySelector("#t-pre").hidden = T.size !== "notional";
  el.querySelector("#t-amt").placeholder = T.size === "notional" ? "0" : "0 sh";
  el.querySelector("#t-amt").style.paddingLeft = T.size === "notional" ? "" : "14px";
  el.querySelector("#t-amt-l").textContent = T.size === "notional" ? "Amount" : "Shares";
  el.querySelector("#t-lim-f").hidden = T.type !== "limit";
  el.querySelector("#t-chips").innerHTML = chipsFor();
  renderReview();
}

function ticketProblem() {
  if (!/^[A-Z]{1,5}(\.[A-Z])?$/.test(T.symbol)) return "Enter a ticker, e.g. SPY.";
  if (T.quote?.error) return T.quote.error;
  if (!(Number(T.amount) > 0)) return "Enter an amount.";
  if (T.type === "limit" && T.size === "notional") return "Limit orders are sized in shares. Switch to Shares.";
  if (T.type === "limit" && !(Number(T.limit) > 0)) return "Enter a limit price.";
  return null;
}

function renderReview() {
  const box = document.getElementById("t-review");
  if (!box) return;
  const err = T.error ? alertHtml(T.error) : "";
  const sideCls = T.side === "buy" ? "buy" : "sell";
  if (!T.review) {
    box.innerHTML = `${err}<button class="btn" id="t-go">Review order</button>`;
    if (T.error) box.querySelector(".alert")?.scrollIntoView({ block: "nearest", behavior: reducedMotion ? "auto" : "smooth" });
    return;
  }
  const price = estPrice(), amt = Number(T.amount);
  const value = T.size === "notional" ? amt : price ? amt * price : null;
  const equity = S.data.account.equity, lim = S.data.settings;
  const pctEq = value != null ? (value / equity) * 100 : null;
  const warn = T.side === "buy" && pctEq != null && pctEq > lim.maxOrderPct
    ? `<div class="alert err">That's ${pctEq.toFixed(1)}% of equity, above your ${lim.maxOrderPct}% max order. The server will block it.</div>` : "";
  box.innerHTML = `<div class="review"><dl>
      <dt>Order</dt><dd>${T.side === "buy" ? "Buy" : "Sell"} <span class="mono">${esc(T.symbol)}</span></dd>
      <dt>Size</dt><dd>${T.size === "notional" ? usd(amt) : `${shares(amt)} sh`}</dd>
      <dt>${T.type === "limit" ? "Limit" : "Est. price"}</dt><dd>${price ? usd(price) : "–"}</dd>
      <dt>Est. value</dt><dd>${value != null ? usd(value) : "–"}${pctEq != null ? ` <span class="mute">· ${pctEq.toFixed(1)}%</span>` : ""}</dd>
      <dt>Type</dt><dd>${T.type === "limit" ? "Limit" : "Market"} · day · paper</dd>
    </dl></div>${warn}${err}
    <button class="btn ${sideCls}" id="t-confirm" ${T.busy ? "disabled" : ""}>${T.busy ? "Placing…" : `Confirm ${T.side}`}</button>
    <button class="btn ghost" id="t-edit">Edit</button>`;
  if (T.error) box.querySelector(".alert.err:last-of-type")?.scrollIntoView({ block: "nearest", behavior: reducedMotion ? "auto" : "smooth" });
}

function wireTrade(el) {
  const sym = el.querySelector("#t-sym"), amt = el.querySelector("#t-amt"), lim = el.querySelector("#t-lim"), note = el.querySelector("#t-note");
  sym.addEventListener("input", () => {
    sym.value = sym.value.toUpperCase().replace(/[^A-Z.]/g, "");
    T.symbol = sym.value; T.review = false; T.error = null;
    clearTimeout(quoteTimer);
    quoteTimer = setTimeout(fetchQuote, 420);
    refreshTicket();
  });
  const num = (inp, key) => inp.addEventListener("input", () => { inp.value = inp.value.replace(/[^0-9.]/g, ""); T[key] = inp.value; if (T.review) { T.review = false; T.error = null; renderReview(); } });
  num(amt, "amount"); num(lim, "limit");
  note.addEventListener("input", () => (T.note = note.value));
  el.onclick = async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.hasAttribute("data-close")) return closeSheet();
    if (b.dataset.side) {
      T.side = b.dataset.side;
      if (T.side === "sell" && position(T.symbol)) T.size = "qty";
      if (T.side === "buy" && T.type === "market") T.size = "notional";
      T.amount = ""; amt.value = ""; T.review = false; T.error = null;
      return refreshTicket();
    }
    if (b.dataset.size) { T.size = b.dataset.size; if (T.size === "notional") T.type = "market"; T.review = false; return refreshTicket(); }
    if (b.dataset.type) { T.type = b.dataset.type; if (T.type === "limit") T.size = "qty"; T.review = false; return refreshTicket(); }
    if (b.dataset.amt) { T.amount = b.dataset.amt; amt.value = T.amount; T.review = false; return renderReview(); }
    if (b.dataset.frac) {
      const p = position(T.symbol), f = Number(b.dataset.frac);
      T.size = "qty"; T.amount = String(f === 1 ? p.qty : Math.floor(p.qty * f * 1e6) / 1e6); amt.value = T.amount; T.review = false;
      return refreshTicket();
    }
    if (b.id === "t-go") {
      T.note = note.value.trim();
      const bad = ticketProblem();
      if (bad) { T.error = bad; return renderReview(); }
      T.error = null; T.review = true; return renderReview();
    }
    if (b.id === "t-edit") { T.review = false; return renderReview(); }
    if (b.id === "t-confirm") return submitTrade();
  };
}

async function submitTrade() {
  T.busy = true; T.error = null; renderReview();
  const body = { symbol: T.symbol, side: T.side, order_type: T.type };
  if (T.size === "notional") body.notional = Number(T.amount); else body.qty = Number(T.amount);
  if (T.type === "limit") body.limit_price = Number(T.limit);
  if (T.note) body.note = T.note;
  try {
    const r = await api("/order", { method: "POST", body: JSON.stringify(body) });
    T.busy = false;
    if (!r.body.ok) { T.error = r.body.message || r.body.error || "Order failed."; return renderReview(); }
    const o = r.body.order;
    closeSheet();
    toast(o.filled_qty
      ? `${o.side === "buy" ? "Bought" : "Sold"} ${shares(o.filled_qty)} ${o.symbol} at ${usd(o.filled_avg_price)}`
      : `${o.side === "buy" ? "Buy" : "Sell"} order for ${o.symbol} placed`);
    await load();
  } catch (err) {
    T.busy = false; T.error = err.message; renderReview();
  }
}

/* limits & account */
function openLimits() {
  const s = S.data.settings, used = S.data.usage.mcp_orders_today;
  const el = document.getElementById("sheet-limits");
  el.innerHTML = `<div class="grab"></div>
    <div class="sheet-h"><h3 id="l-title">Limits</h3><button class="icon-btn" data-close aria-label="Close">${I.close}</button></div>
    <p class="hint" style="margin-top:-6px">Enforced on the server for every order, Claude's and yours. Claude has no tool to change them.</p>
    <form id="l-form">
      <div class="row2">
        <div class="field"><label for="l1">Max order</label><div class="affix"><input class="input" id="l1" inputmode="decimal" value="${s.maxOrderPct}"><span class="pre" style="left:auto;right:14px;font:500 15px var(--sans)">% eq.</span></div></div>
        <div class="field"><label for="l2">Max position</label><div class="affix"><input class="input" id="l2" inputmode="decimal" value="${s.maxPositionPct}"><span class="pre" style="left:auto;right:14px;font:500 15px var(--sans)">% eq.</span></div></div>
      </div>
      <div class="field"><label for="l3">Claude orders per day</label><input class="input" id="l3" inputmode="numeric" value="${s.maxOrdersPerDay}">
        <div class="meter" aria-hidden="true"><i style="width:${Math.min(100, (used / s.maxOrdersPerDay) * 100)}%"></i></div>
        <div class="hint">${used} used today. Your own trades don't count.</div></div>
      <div class="field"><label for="l4">Symbol allowlist</label><input class="input" id="l4" value="${esc(s.allowlist.join(", "))}" placeholder="Empty means any US stock or ETF" autocapitalize="characters" autocomplete="off"></div>
      <div id="l-msg"></div>
      <button class="btn" type="submit">Save limits</button>
    </form>
    <div class="who-line"><span>Signed in as <b style="color:var(--ink);font-weight:500">${esc(S.login)}</b></span><button class="chip flat" style="border:0" id="logout">Sign out</button></div>`;
  openSheet("sheet-limits");
  el.querySelector("[data-close]").onclick = closeSheet;
  el.querySelector("#logout").onclick = async () => { await sb.auth.signOut(); location.reload(); };
  el.querySelector("#l-form").onsubmit = async (e) => {
    e.preventDefault();
    const v = (id) => el.querySelector(id).value;
    const r = await api("/settings", { method: "PUT", body: JSON.stringify({ maxOrderPct: v("#l1"), maxPositionPct: v("#l2"), maxOrdersPerDay: v("#l3"), allowlist: v("#l4") }) });
    if (!r.body.ok) { el.querySelector("#l-msg").innerHTML = `<div class="alert err">${esc(r.body.message || "Could not save.")}</div>`; return; }
    S.data.settings = r.body.settings;
    closeSheet();
    toast("Limits saved");
  };
}

/* ---------- data ---------- */
async function loadHistory(period) {
  const r = await api(`/history?period=${period}`);
  S.history[period] = r.body.points ?? [];
}

async function load() {
  const [p, t, n] = await Promise.all([api("/portfolio"), api("/trades?limit=40"), api("/notes?limit=20"), loadHistory(S.period), loadHistory("all")]);
  if (p.status !== 200) throw new Error(p.body.error || "Could not load the portfolio");
  S.data = p.body;
  S.trades = t.body.trades ?? [];
  S.notes = n.body.notes ?? [];
  renderMain();
}

/* ---------- events on the main view ---------- */
function wireMain() {
  const main = document.getElementById("main");
  main.addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.id === "refresh") {
      b.classList.add("spin");
      try { await load(); toast("Up to date"); } catch (err) { toast(err.message); }
      return;
    }
    if (b.id === "limits") return openLimits();
    if (b.id === "bar-trade") return openTrade();
    if (b.dataset.period) {
      S.period = b.dataset.period;
      if (!S.history[S.period]) await loadHistory(S.period);
      S.animateChart = true;
      return renderMain();
    }
    if (b.dataset.feed) { S.feed = b.dataset.feed; return renderMain(); }
    if (b.dataset.sym) return openTrade(b.dataset.sym);
    if (b.classList.contains("more")) { b.previousElementSibling.classList.remove("clamp"); b.remove(); return; }
    if (b.dataset.cancel) {
      if (!confirm("Cancel this order?")) return;
      const r = await api("/cancel", { method: "POST", body: JSON.stringify({ order_id: b.dataset.cancel }) });
      toast(r.body.ok ? "Order canceled" : r.body.message || "Cancel failed");
      return load();
    }
  });
  let resizeTimer;
  addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(mountChart, 120); });
  // Quiet refresh every minute while the market is open and nobody is mid-interaction.
  setInterval(() => {
    if (document.hidden || S.sheet || S.scrubbing || !S.data?.market.is_open) return;
    load().catch(() => {});
  }, 60_000);
}

/* ---------- boot ---------- */
async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return renderGate();
  S.login = String(session.user.user_metadata?.user_name ?? "").toLowerCase();
  if (S.login !== ALLOWED_GITHUB_LOGIN.toLowerCase()) {
    await sb.auth.signOut();
    return renderGate(`The GitHub account "${S.login}" doesn't have access.`);
  }
  mountShell();
  wireMain();
  document.getElementById("main").innerHTML = `<div class="skeleton">Loading</div>`;
  try {
    await load();
  } catch (err) {
    document.getElementById("main").innerHTML = `<div class="skeleton" style="text-transform:none;letter-spacing:0;font:14px var(--sans);gap:14px"><span class="loss">${esc(err.message)}</span><button class="chip flat" style="border:0" onclick="location.reload()">Retry</button></div>`;
  }
}
boot();

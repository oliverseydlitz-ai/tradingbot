import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.116.0/+esm";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, ALLOWED_GITHUB_LOGIN } from "/config.js";

const API = `${SUPABASE_URL}/functions/v1/mcp/api`;
const sb = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
const root = document.getElementById("app");
const finePointer = matchMedia("(pointer: fine)").matches;
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ---------- formatting ---------- */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const last = (a) => a[a.length - 1];
const MINUS = "−";
// Round first, then pick the sign, so a value that displays as 0.00 never reads "−0.00" or turns red.
const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d || 0;
const sign = (n, d = 2) => { const r = round(n, d); return r > 0 ? "+" : r < 0 ? MINUS : ""; };
const tone = (n, d = 2) => { const r = round(n, d); return r > 0 ? "gain" : r < 0 ? "loss" : "flat"; };
const usd = (n, d = 2) =>
  (round(n, d) < 0 ? MINUS : "") + "$" + Math.abs(round(n, d)).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const usdShort = (n) => (Math.abs(n) >= 1000 ? usd(n, 0) : usd(n));
const pct = (n, d = 2) => `${sign(n, d)}${Math.abs(round(n, d)).toFixed(d)}%`;
const pts = (n) => `${sign(n)}${Math.abs(round(n, 2)).toFixed(2)} pts`;
// Amounts typed by hand: "1,250.50" is fine, "1.2.3" is not.
const parseAmount = (s) => { const t = String(s ?? "").replace(/[,\s]/g, ""); return /^(\d+\.?\d*|\.\d+)$/.test(t) ? Number(t) : NaN; };
const cleanName = (n) => String(n ?? "").replace(/\s+(Class [A-Z] )?(Common|Ordinary) (Stock|Shares)$/i, "").replace(/\s+Common Stock$/i, "");
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
const money = (n) => {
  const [w, c] = usd(n).split(".");
  const neg = w.startsWith(MINUS);
  return `${neg ? MINUS : ""}<span class="cur">$</span>${w.replace(/^\u2212?\$/, "")}<span class="cents">.${c}</span>`;
};
const localDay = (d) => new Date(d).toLocaleDateString("en-CA");
function dayLabel(iso) {
  const day = localDay(iso), today = localDay(Date.now()), yest = localDay(Date.now() - 864e5);
  if (day === today) return "Today";
  if (day === yest) return "Yesterday";
  return new Date(iso).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
}
const clock = (d) => new Date(d).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
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
  return `<div class="alert err" role="alert">${e.title ? `<b>${esc(e.title)}.</b> ` : ""}${esc(e.detail)}</div>`;
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
  check: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>`,
  warn: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M8 4.5v4.5M8 11.6v.1"/></svg>`,
  block: `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="M4.2 11.8l7.6-7.6"/></svg>`,
  github: `<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`,
};
const arrow = (v) => ({ gain: I.up, loss: I.down })[tone(v)] ?? "";
const deltaChip = (v, text) => `<span class="chip ${tone(v)}">${arrow(v)}${text}</span>`;

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
  updatedAt: null,
  prev: null,        // last rendered values, for the tick flash on refresh
  prevPeriod: null,  // for the sliding period indicator
  open: new Set(),   // feed items the user expanded; survives refreshes
  lastInput: 0,      // last touch/scroll/key, so auto-refresh never yanks the page mid-gesture
  tapeT0: null,      // ticker start time, so re-renders continue the scroll instead of restarting it
  tapePaused: false,
  tapeAt: 0,
  expired: false,
  tradesAt: 0,      // when the trade log last loaded successfully
};
const T = { symbol: "", side: "buy", size: "notional", type: "market", amount: "", limit: "", note: "", quote: null, review: false, busy: false, error: null };

async function api(path, { timeout = 20_000, ...opts } = {}) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { expire(); throw new Error("Signed out."); }
  let res;
  try {
    res = await fetch(API + path, {
      ...opts,
      signal: AbortSignal.timeout?.(timeout),
      headers: { authorization: `Bearer ${session.access_token}`, "content-type": "application/json" },
    });
  } catch (e) {
    throw new Error(e?.name === "TimeoutError" ? "The server took too long to answer." : "Network error. Check your connection.");
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) { await sb.auth.signOut().catch(() => {}); expire(); throw new Error("Your session expired."); }
  return { status: res.status, body };
}

// Session gone: back to the sign-in screen once, without a reload loop.
function expire() {
  if (S.expired) return;
  S.expired = true;
  S.sheet = null;
  document.body.style.overflow = "";
  renderGate("Your session expired. Sign in again to continue.");
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
      ${note ? `<div class="alert err" role="alert">${esc(note)}</div>` : ""}
      <button class="btn gh" id="login" style="margin:0">${I.github}<span>Continue with GitHub</span></button>
      <p class="hint">Private dashboard. One account only.</p>
    </div>
  </main>`;
  document.getElementById("login").onclick = () =>
    sb.auth.signInWithOAuth({ provider: "github", options: { redirectTo: location.origin + "/" } });
}

/* ---------- shell (persistent: sheets, fab, toast survive re-renders) ---------- */
let fabIO, barIO, fabNear = false, barSeen = true;
function mountShell() {
  root.innerHTML = `<main class="shell" id="main"></main>
    <button class="fab away" id="fab">${I.plus}<span>Trade</span></button>
    <div class="scrim" id="scrim"></div>
    <section class="sheet" id="sheet-trade" role="dialog" aria-modal="true" aria-labelledby="t-title"></section>
    <section class="sheet" id="sheet-limits" role="dialog" aria-modal="true" aria-labelledby="l-title"></section>
    <div class="toast" id="toast" role="status" aria-live="polite"></div>`;
  document.getElementById("fab").onclick = () => openTrade();
  document.getElementById("scrim").onclick = closeSheet;
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && S.sheet) closeSheet(); });
  // The floating Trade button steps aside while the chart sits in the bottom band, so it never covers the plot or the period tabs.
  // It also stays hidden while the top bar (which has its own Trade button) is on screen.
  if ("IntersectionObserver" in window) {
    fabIO = new IntersectionObserver((es) => { fabNear = es.some((e) => e.isIntersecting); syncFab(); }, { rootMargin: "-84% 0px 0px 0px" });
    barIO = new IntersectionObserver((es) => { barSeen = es.some((e) => e.isIntersecting); syncFab(); });
  } else barSeen = false;
  // Keep a bottom sheet above the on-screen keyboard (iOS overlays it instead of resizing the page).
  const vv = window.visualViewport;
  const fit = () => {
    const el = S.sheet && document.getElementById(S.sheet);
    if (el) el.style.setProperty("--kb", `${Math.max(0, Math.round(innerHeight - vv.height - vv.offsetTop))}px`);
  };
  vv?.addEventListener("resize", fit);
  vv?.addEventListener("scroll", fit);
}
function syncFab() {
  document.getElementById("fab")?.classList.toggle("away", barSeen || fabNear || S.scrubbing);
}

let toastTimer;
function toast(msg, kind = "ok") {
  const t = document.getElementById("toast");
  if (!t) return;
  t.setAttribute("role", kind === "err" ? "alert" : "status");
  t.setAttribute("aria-live", kind === "err" ? "assertive" : "polite");
  t.innerHTML = `<span class="toast-i ${kind}">${kind === "ok" ? I.check : I.warn}</span><span>${esc(msg)}</span>`;
  t.classList.add("on");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("on"), kind === "err" ? 5000 : 3200);
}

/* ---------- main view ---------- */
function marketBits(m) {
  return m.is_open
    ? { cls: "open", chip: "Open", cd: untilText(m.next_close), line: `Market closes in ${untilText(m.next_close)}` }
    : { cls: "", chip: "Closed", cd: opensText(m.next_open), line: `Market opens ${opensText(m.next_open)}` };
}

function heroHtml(d) {
  const a = d.account;
  const mk = marketBits(d.market);
  const all = S.history.all ?? [];
  const since = all.length >= 2 ? (() => {
    const diff = a.equity - all[0].equity, p = (a.equity / all[0].equity - 1) * 100;
    return `<span>All-time <b class="${tone(diff)}">${sign(diff)}${usd(Math.abs(diff))} (${pct(p)})</b></span>`;
  })() : "";
  return `<section class="hero" aria-labelledby="eq-l">
    <h2 class="eyebrow" id="eq-l" style="margin:0">Paper equity</h2>
    <div class="equity num" id="equity" data-v="${a.equity}" data-tick="equity">${money(a.equity)}</div>
    <div class="delta">${deltaChip(a.day_pl, `${sign(a.day_pl)}${usd(Math.abs(a.day_pl))}`)}<span class="${tone(a.day_pl_pct) === "flat" ? "mute" : tone(a.day_pl_pct)}">${pct(a.day_pl_pct)}</span><span class="mute">today</span></div>
    <div class="meta">${since}<span class="mk">${esc(mk.line)}</span></div>
  </section>`;
}

function tapeHtml(d) {
  if (!d.positions.length) return "";
  const items = [...d.positions].sort((a, b) => a.symbol.localeCompare(b.symbol))
    .map((p) => `<span class="tape-item"><b>${esc(p.symbol)}</b><span class="num">${usd(p.current_price)}</span><span class="${tone(p.day_pl_pct)} num tape-d">${arrow(p.day_pl_pct)}${Math.abs(round(p.day_pl_pct, 2)).toFixed(2)}%</span></span>`).join("");
  const dur = Math.max(18, d.positions.length * 5);
  // Continue from where the last render left off instead of jumping back to the start.
  S.tapeT0 ??= performance.now();
  const at = S.tapePaused ? S.tapeAt : (performance.now() - S.tapeT0) / 1000;
  return `<button class="tape${S.tapePaused ? " paused" : ""}" id="tape" aria-pressed="${S.tapePaused}" aria-label="Pause the price ticker"><span class="tape-track" aria-hidden="true" style="animation-duration:${dur}s;animation-delay:-${(at % dur).toFixed(2)}s">${items}${items}</span></button>`;
}

function scoreHtml() {
  const p = S.history.all ?? [];
  if (p.length < 2) {
    return `<section class="card score"><div class="card-h"><h2>The race</h2><span class="aside">vs S&amp;P 500</span></div>
      <div class="vs"><div class="side"><div class="who"><i></i>Claude</div><div class="ret num">0.00%</div></div><div class="vs-mid">vs</div><div class="side spy"><div class="who"><i></i>SPY</div><div class="ret num">0.00%</div></div></div>
      <div class="verdict"><span><strong>Day one.</strong> The scoreboard starts after the first full trading day.</span></div></section>`;
  }
  const end = last(p), c = end.portfolio - 100, s = end.spy - 100, lead = round(c - s, 2);
  // Tug of war on a fixed ±5-point scale: the bar pulls toward whoever leads (Claude left, SPY right).
  const D = 5, over = Math.abs(lead) > D, half = Math.min(Math.abs(lead) / D, 1) * 50;
  const bar = lead >= 0
    ? `<b style="left:${50 - half}%;width:${half}%;background:var(--accent)"></b>`
    : `<b style="left:50%;width:${half}%;background:var(--spy)"></b>`;
  const ahead = p.slice(1).filter((q) => q.portfolio > q.spy).length;
  const verdict = lead === 0 ? "<strong>Dead even.</strong>"
    : lead > 0 ? `<strong>Claude leads</strong> by ${pts(lead).slice(1)}` : `<strong>SPY leads</strong> by ${pts(-lead).slice(1)}`;
  return `<section class="card score"><div class="card-h"><h2>The race</h2><span class="aside">since ${esc(fmtDay(p[0].date))}</span></div>
    <div class="vs">
      <div class="side"><div class="who"><i></i>Claude</div><div class="ret num ${tone(c)}">${pct(c)}</div></div>
      <div class="vs-mid">vs</div>
      <div class="side spy"><div class="who"><i></i>SPY</div><div class="ret num">${pct(s)}</div></div>
    </div>
    <div class="race" role="img" aria-label="${esc(lead === 0 ? "Even" : `${lead > 0 ? "Claude" : "SPY"} ahead by ${pts(Math.abs(lead)).slice(1)}`)}">${bar}</div>
    <div class="race-scale" aria-hidden="true"><span class="${over && lead > 0 ? "hit" : ""}">${over && lead > 0 ? "◂ " : ""}Claude +${D}</span><span>even</span><span class="${over && lead < 0 ? "hit" : ""}">SPY +${D}${over && lead < 0 ? " ▸" : ""}</span></div>
    <div class="verdict"><span>${verdict}</span><span class="mono-s">Ahead ${ahead} of ${p.length - 1} days</span></div>
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
    <div class="readout">
      <span class="k"><i></i>Claude<b class="v num" id="ro-p"></b></span>
      <span class="k"><i class="d"></i>SPY<b class="v num" id="ro-s"></b></span>
      <span class="when" id="ro-w"></span>
    </div>
    ${body}
    <div class="tabs" role="group" aria-label="Period"><span class="tab-ind" aria-hidden="true"></span>${periods.map(([k, l]) => `<button data-period="${k}" aria-pressed="${k === S.period}">${l}</button>`).join("")}</div>
  </section>`;
}

const ALLOC_COLOR = { Stocks: "var(--cat-1)", ETFs: "var(--cat-2)", "Bond ETFs": "var(--cat-3)", Cash: "var(--cat-cash)" };
function allocationHtml(d) {
  const color = (a) => ALLOC_COLOR[a.label] ?? "var(--ctl)";
  const total = d.allocation.reduce((s, a) => s + a.value, 0) || 1;
  return `<section class="card"><div class="card-h"><h2>Allocation</h2><span class="aside">${d.positions.length} position${d.positions.length === 1 ? "" : "s"}</span></div>
    <div class="alloc-bar" role="img" aria-label="${esc(d.allocation.map((a) => `${a.label} ${((a.value / total) * 100).toFixed(1)}%`).join(", "))}">
      ${d.allocation.map((a, i) => (a.value > 0.5 ? `<i style="flex:${a.value};background:${color(a)};animation-delay:${i * 80}ms"></i>` : "")).join("")}
    </div>
    <div class="legend">${d.allocation.map((a) => `<div><i style="background:${color(a)}"></i><span class="l">${esc(a.label)}</span><span class="p">${((a.value / total) * 100).toFixed(1)}%<small>${usdShort(a.value)}</small></span></div>`).join("")}</div>
  </section>`;
}

function performanceHtml(d) {
  const rows = [...d.positions].sort((a, b) => b.unrealized_pl_pct - a.unrealized_pl_pct);
  if (!rows.length) return "";
  // One runaway winner shouldn't flatten every other bar: cap the scale near the runner-up and mark clipped bars.
  const mags = rows.map((r) => Math.abs(r.unrealized_pl_pct)).sort((a, b) => b - a);
  const cap = mags.length >= 4 && mags[0] > 2.5 * mags[1] ? mags[1] * 1.4 : mags[0];
  const max = Math.max(0.5, cap);
  const fill = { gain: "var(--gain)", loss: "var(--loss)", flat: "var(--mute)" };
  return `<section class="card"><div class="card-h"><h2>Best to worst</h2><span class="aside">return since entry</span></div>
    <div class="perf">${rows.map((r, i) => {
      const v = r.unrealized_pl_pct, t = tone(v), neg = t === "loss", clip = Math.abs(v) > max;
      const w = Math.max((Math.min(Math.abs(v), max) / max) * 50, 0.6);
      return `<div class="perf-row"><span class="s">${esc(r.symbol)}</span>
        <span class="t"><b class="${clip ? `clip${neg ? " neg" : ""}` : ""}" style="left:${neg ? 50 - w : 50}%;width:${w}%;background:${fill[t]};--o:${neg ? "right" : "left"};animation-delay:${i * 40}ms"></b></span>
        <span class="v ${t}">${pct(v)}</span></div>`;
    }).join("")}</div>
    <div class="perf-scale" aria-hidden="true"><span>${MINUS}${max.toFixed(1)}%</span><span>0</span><span>+${max.toFixed(1)}%</span></div>
  </section>`;
}

const CAT_COLOR = { Stock: "var(--cat-1)", ETF: "var(--cat-2)", "Bond ETF": "var(--cat-3)" };
function holdingsHtml(d) {
  const rows = [...d.positions].sort((a, b) => b.market_value - a.market_value);
  const dot = `<i class="dot" aria-hidden="true"></i>`;
  return `<section class="card"><div class="card-h"><h2>Holdings</h2><span class="aside">${finePointer ? "click" : "tap"} a row to trade</span></div>
    ${rows.length ? `<div class="holdings"><div class="h-head" aria-hidden="true"><span>Position</span><span>Value · total return</span></div>${rows.map((p) => `<button class="h-row" data-sym="${esc(p.symbol)}">
      <span class="h-main">
        <span class="h-sym"><b><span class="sr">Trade </span>${esc(p.symbol)}</b><span>${esc(cleanName(p.name))}</span></span>
        <span class="h-sub"><span class="cat" style="--c:${CAT_COLOR[p.category] ?? "var(--ctl)"}"><i aria-hidden="true"></i>${esc(p.category)}</span>${dot}<span>${p.weight_pct.toFixed(1)}%<span class="sh"> of equity</span></span><span class="sh">${dot}<span>${shares(p.qty)} sh</span></span>${dot}<span class="${tone(p.day_pl_pct)}">${pct(p.day_pl_pct)} today</span></span>
      </span>
      <span class="h-right">
        <span class="h-val" data-tick="pos:${esc(p.symbol)}" data-v="${p.market_value}">${usd(p.market_value)}</span>
        <span class="h-pl ${tone(p.unrealized_pl)}">${sign(p.unrealized_pl)}${usd(Math.abs(p.unrealized_pl))} · ${pct(p.unrealized_pl_pct)}</span>
      </span>
    </button>`).join("")}</div>` : `<p class="empty">No positions yet. Claude's first run, or a tap on Trade, fills this in.</p>`}
  </section>`;
}

function openOrdersHtml(d) {
  if (!d.open_orders.length) return "";
  return `<section class="card"><div class="card-h"><h2>Working orders</h2><span class="aside">${d.open_orders.length}</span></div>
    ${d.open_orders.map((o) => `<div class="order"><span><b>${esc(String(o.side).toUpperCase())} ${esc(o.symbol)}</b> <span class="mute">${o.qty ? `${shares(Number(o.qty))} sh` : usd(Number(o.notional))} · ${esc(o.type)}${o.limit_price ? ` @ ${usd(Number(o.limit_price))}` : ""}</span></span>
      <button class="chip flat" style="border:0" data-cancel="${esc(o.id)}" aria-label="Cancel ${esc(o.side)} order for ${esc(o.symbol)}">Cancel</button></div>`).join("")}
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
  const side = t.side === "sell" ? "sell" : "buy";
  const key = `t${t.id}`, open = S.open.has(key);
  const long = (t.reason ?? "").length > 220;
  return `<article class="ev">
    <span class="ev-dot ${blocked ? "" : side}" aria-hidden="true">${blocked ? I.block : I[side]}</span>
    <div><div class="ev-top"><span class="ev-title">${esc(titles[t.status] ?? t.status)} <span class="mono">${esc(t.symbol)}</span> <span class="mute num">${amt}</span></span><time class="ev-time" datetime="${esc(t.created_at)}" title="${esc(relTime(t.created_at))}">${esc(clock(t.created_at))}</time></div>
      <div class="ev-tags">${t.source === "manual" ? `<span class="tag">You</span>` : `<span class="tag ai">Claude</span>`}${blocked ? `<span class="tag warn">${esc(explain(t.error).title ?? (t.status === "rejected" ? "Guardrail" : "Error"))}</span>` : ""}</div>
      ${t.reason ? `<div class="ev-body${long && !open ? " clamp" : ""}" id="b-${key}">${esc(t.reason)}</div>${long ? moreBtn(key, open) : ""}` : ""}
      ${t.error ? `<div class="ev-err">${esc(explain(t.error).detail)}</div>` : ""}
    </div></article>`;
}

const moreBtn = (key, open) =>
  `<button class="more" data-more="${esc(key)}" aria-expanded="${open}" aria-controls="b-${esc(key)}">${open ? "Show less" : "Read more"}</button>`;

function noteEvent(n) {
  const key = `n${n.id}`, open = S.open.has(key);
  const long = n.body.length > 260 || n.body.split("\n").length > 4;
  return `<article class="ev">
    <span class="ev-dot note" aria-hidden="true">${I.note}</span>
    <div><div class="ev-top"><span class="ev-title">${esc(n.title || "Note")}</span><time class="ev-time" datetime="${esc(n.created_at)}" title="${esc(relTime(n.created_at))}">${esc(clock(n.created_at))}</time></div>
      ${(n.tags ?? []).length ? `<div class="ev-tags">${n.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>` : ""}
      <div class="ev-body${long && !open ? " clamp" : ""}" id="b-${key}">${esc(n.body)}</div>${long ? moreBtn(key, open) : ""}
    </div></article>`;
}

function feedHtml() {
  const tab = S.feed ?? (S.notes.length ? "journal" : "trades");
  const grouped = (items, render) => {
    const out = [];
    let last = null;
    for (const it of items) {
      const label = dayLabel(it.created_at);
      if (label !== last) { if (last !== null) out.push("</div>"); out.push(`<div class="day"><div class="day-h">${esc(label)}</div>`); last = label; }
      out.push(render(it));
    }
    if (last !== null) out.push("</div>");
    return out.join("");
  };
  const list = tab === "journal"
    ? (S.notes.length ? grouped(S.notes, noteEvent) : `<p class="empty">Claude hasn't written a note yet. Each scheduled run ends with one.</p>`)
    : (S.trades.length ? grouped(S.trades, tradeEvent) : `<p class="empty">No trades yet.</p>`);
  return `<section class="card"><div class="card-h" style="align-items:center"><h2>${tab === "journal" ? "Claude's journal" : "Trade log"}</h2>
      <div class="seg" role="group" aria-label="Feed"><button data-feed="journal" aria-pressed="${tab === "journal"}">Journal</button><button data-feed="trades" aria-pressed="${tab === "trades"}">Trades</button></div></div>
    <div class="feed">${list}</div></section>`;
}

// A stable selector for a focused control, so focus survives a re-render (or comes back after a sheet closes).
function focusKey(el) {
  if (!el || el === document.body) return null;
  if (el.id) return `#${CSS.escape(el.id)}`;
  for (const a of ["data-sym", "data-period", "data-feed", "data-cancel", "data-more"]) {
    if (el.hasAttribute?.(a)) return `[${a}="${CSS.escape(el.getAttribute(a))}"]`;
  }
  return null;
}
const refocus = (key) => { if (key) document.querySelector(key)?.focus({ preventScroll: true }); };

function renderMain() {
  const d = S.data;
  const mk = marketBits(d.market);
  const main = document.getElementById("main");
  const had = main.contains(document.activeElement) ? focusKey(document.activeElement) : null;
  main.innerHTML = `
    <h1 class="sr">Portfolio: Claude versus the S&amp;P 500</h1>
    <header class="bar">
      <div class="mark">${I.mark}<span>Portfolio</span></div>
      <div class="bar-right">
        <span class="status ${mk.cls}" title="${esc(mk.line)}"><i></i>${mk.chip}<span class="cd">${esc(mk.cd)}</span></span>
        <button class="icon-btn" id="refresh" aria-label="Refresh">${I.refresh}</button>
        <button class="icon-btn" id="limits" aria-label="Limits and account">${I.sliders}</button>
        <button class="bar-trade" id="bar-trade" title="New trade">${I.plus}<span>Trade</span></button>
      </div>
    </header>
    ${tapeHtml(d)}
    <div class="top">${heroHtml(d)}${scoreHtml()}</div>
    <div class="grid">
      <div class="col">${chartCardHtml()}${holdingsHtml(d)}${openOrdersHtml(d)}</div>
      <div class="col">${allocationHtml(d)}${performanceHtml(d)}${feedHtml()}</div>
    </div>
    <footer class="foot"><span>Alpaca paper account · IEX data · updated ${esc(clock(S.updatedAt ?? Date.now()))}${d.market.is_open ? " · live" : ""}</span><span>Signed in as ${esc(S.login)}</span></footer>`;
  if (!S.firstPaint) main.classList.add("settled");
  mountChart();
  if (S.firstPaint) countUp();
  flashTicks(main);
  refocus(had);
  if (fabIO) {
    fabIO.disconnect(); barIO.disconnect();
    const c = main.querySelector(".chart-card"); if (c) fabIO.observe(c);
    barIO.observe(main.querySelector(".bar"));
  }
  const t = tone(d.account.day_pl_pct);
  document.title = `${usd(d.account.equity, 0)} ${t === "loss" ? "▼" : t === "gain" ? "▲" : "·"} ${Math.abs(round(d.account.day_pl_pct, 2)).toFixed(2)}% · Portfolio`;
  S.firstPaint = false;
}

// Values that moved since the last refresh flash once in the direction they moved.
function flashTicks(main) {
  const now = {};
  main.querySelectorAll("[data-tick]").forEach((el) => {
    const k = el.dataset.tick, v = Number(el.dataset.v);
    now[k] = v;
    const before = S.prev?.[k];
    if (before == null || Math.abs(v - before) < 0.005 || reducedMotion) return;
    el.classList.add(v > before ? "tick-up" : "tick-down");
  });
  S.prev = now;
}

function countUp() {
  const el = document.getElementById("equity");
  if (!el || reducedMotion) return;
  const target = Number(el.dataset.v), from = target * 0.985, t0 = performance.now(), dur = 900;
  const step = (now) => {
    const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
    el.innerHTML = money(from + (target - from) * e);
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
  const range = points.length ? `${fmtDay(points[0].date)} – ${fmtDay(last(points).date)}` : "";
  // Idle, the readout is just the legend; values appear while scrubbing (the line-end tags already show the latest).
  const setReadout = (p, label) => {
    const rp = document.getElementById("ro-p"), rs = document.getElementById("ro-s"), rw = document.getElementById("ro-w");
    if (!rp) return;
    rp.textContent = p ? pct(p.portfolio - 100) : ""; rp.className = `v num ${p ? tone(p.portfolio - 100) : ""}`;
    rs.textContent = p ? pct(p.spy - 100) : "";
    rw.textContent = label;
  };
  setReadout(null, range);
  if (!el || points.length < 2) return;

  const n = points.length, endP = last(points).portfolio - 100, endS = last(points).spy - 100;
  const W = el.clientWidth, H = el.clientHeight, padT = 12, padB = 28, padL = 18;
  // Both end tags share one precision and keep their "%"; the right gutter fits the wider one.
  const tagDec = Math.max(Math.abs(endP), Math.abs(endS)) >= 10 ? 1 : 2;
  const tagP = pct(endP, tagDec), tagS = pct(endS, tagDec);
  const tagW = Math.ceil(Math.max(tagP.length, tagS.length) * 6.7 + 12), padR = tagW + 8;

  const vals = points.flatMap((p) => [p.portfolio - 100, p.spy - 100]).concat(0);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 0.4) { const mid = (hi + lo) / 2; lo = mid - 0.2; hi = mid + 0.2; } // a flat week shouldn't look like a cliff
  const pad = (hi - lo) * 0.12;
  lo -= pad; hi += pad;
  const x = (i) => padL + (i / (n - 1)) * (W - padL - padR);
  const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);
  const line = (k) => points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p[k] - 100).toFixed(1)}`).join("");
  const step = niceStep(hi - lo);
  const dec = Math.min(3, (String(+step.toPrecision(3)).split(".")[1] ?? "").length);
  const ticks = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) ticks.push(round(v, 6));
  const xl = [0, Math.floor((n - 1) / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i);
  // Price-tag labels at the right edge for both series' latest value, nudged apart if they collide.
  let tp = y(endP), ts = y(endS);
  if (Math.abs(tp - ts) < 20) { const mid = (tp + ts) / 2, dir = tp <= ts ? -1 : 1; tp = mid + dir * 10; ts = mid - dir * 10; }
  const tag = (ty, text, fill, ink, stroke) =>
    `<g class="fade" transform="translate(${W - tagW - 1} ${ty - 9.5})"><rect width="${tagW}" height="19" rx="5" fill="${fill}" ${stroke ? `stroke="${stroke}"` : ""}/><text x="${tagW / 2}" y="13.2" text-anchor="middle" font-size="11" font-weight="500" font-family="var(--mono)" fill="${ink}">${esc(text)}</text></g>`;
  const nearTag = (yy) => Math.abs(yy - tp) < 14 || Math.abs(yy - ts) < 14;
  const gid = `g${Math.random().toString(36).slice(2, 7)}`;
  // The fill is anchored at 0%: amber above the line of no change, a loss tint below it.
  const y0 = y(0), area = `${line("portfolio")}L${x(n - 1).toFixed(1)} ${y0.toFixed(1)}L${x(0).toFixed(1)} ${y0.toFixed(1)}Z`;
  const summary = `Claude ${pct(endP)}, SPY ${pct(endS)}, ${range}`;

  el.classList.toggle("anim", S.animateChart && !reducedMotion);
  el.tabIndex = 0;
  el.setAttribute("role", "slider");
  el.setAttribute("aria-label", "Return chart. Use the arrow keys to step through days.");
  el.setAttribute("aria-valuemin", "0");
  el.setAttribute("aria-valuemax", String(n - 1));
  el.setAttribute("aria-valuenow", String(n - 1));
  el.setAttribute("aria-valuetext", summary);
  el.innerHTML = `<svg width="${W}" height="${H}" aria-hidden="true">
    <defs>
      <linearGradient id="${gid}u" gradientUnits="userSpaceOnUse" x1="0" y1="${padT}" x2="0" y2="${y0}"><stop offset="0" stop-color="var(--accent)" stop-opacity=".24"/><stop offset="1" stop-color="var(--accent)" stop-opacity=".03"/></linearGradient>
      <linearGradient id="${gid}d" gradientUnits="userSpaceOnUse" x1="0" y1="${y0}" x2="0" y2="${H - padB}"><stop offset="0" stop-color="var(--loss)" stop-opacity=".04"/><stop offset="1" stop-color="var(--loss)" stop-opacity=".2"/></linearGradient>
      <clipPath id="${gid}a"><rect x="0" y="0" width="${W}" height="${Math.max(0, y0)}"/></clipPath>
      <clipPath id="${gid}b"><rect x="0" y="${y0}" width="${W}" height="${Math.max(0, H - y0)}"/></clipPath>
    </defs>
    ${ticks.map((v) => {
      const yy = y(v), near = nearTag(yy);
      if (near && v !== 0) return ""; // drop the gridline and its label together; the zero line always stays
      return `<line x1="${padL}" x2="${W - padR}" y1="${yy}" y2="${yy}" stroke="${v === 0 ? "var(--ctl)" : "var(--line)"}" ${v === 0 ? "" : 'stroke-dasharray="2 4"'}/>${near ? "" : `<text x="${W - 2}" y="${yy + 4}" text-anchor="end" font-size="11" font-family="var(--mono)" fill="var(--mute)">${v === 0 ? "0%" : pct(v, dec)}</text>`}`;
    }).join("")}
    <path class="fade" d="${area}" fill="url(#${gid}u)" clip-path="url(#${gid}a)"/>
    <path class="fade" d="${area}" fill="url(#${gid}d)" clip-path="url(#${gid}b)"/>
    <path class="fade" d="${line("spy")}" fill="none" stroke="var(--spy)" stroke-width="1.5" stroke-dasharray="4 4" stroke-linejoin="round" opacity=".85"/>
    <path class="draw" d="${line("portfolio")}" fill="none" stroke="var(--accent)" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle class="halo" cx="${x(n - 1)}" cy="${y(endP)}" r="3.5" fill="var(--accent)"/>
    <circle class="fade" cx="${x(n - 1)}" cy="${y(endP)}" r="3.5" fill="var(--accent)"/>
    ${tag(ts, tagS, "var(--surface-2)", "var(--ink-2)", "var(--ctl)")}
    ${tag(tp, tagP, "var(--accent)", "var(--accent-ink)")}
    <g class="xl">${xl.map((i, k) => `<text x="${x(i)}" y="${H - 7}" font-size="11" font-family="var(--mono)" fill="var(--mute)" text-anchor="${k === 0 ? "start" : k === xl.length - 1 ? "end" : "middle"}">${esc(fmtDay(points[i].date))}</text>`).join("")}</g>
    <g id="xh" style="display:none"><line y1="${padT}" y2="${H - padB}" stroke="var(--ink-2)" stroke-width="1" opacity=".5"/><circle r="4.5" fill="var(--accent)" stroke="var(--surface)" stroke-width="2"/><circle r="4" fill="var(--spy)" stroke="var(--surface)" stroke-width="2"/>
      <g class="xh-pill"><rect y="${H - padB + 6}" height="19" rx="5" fill="var(--ink)"/><text y="${H - padB + 19.5}" text-anchor="middle" font-size="11" font-weight="500" font-family="var(--mono)" fill="var(--bg)"></text></g></g>
  </svg>`;
  // The line-draw animation needs the path's real length.
  el.querySelectorAll("path.draw").forEach((p) => p.style.setProperty("--len", Math.ceil(p.getTotalLength())));
  S.animateChart = false;
  slideTabs();

  const svg = el.firstElementChild, xh = svg.querySelector("#xh"), [vl, c1, c2] = xh.children, xlabels = svg.querySelector(".xl");
  const pill = xh.querySelector(".xh-pill"), pr = pill.querySelector("rect"), pt = pill.querySelector("text");
  const show = (i) => {
    const p = points[i], cx = x(i);
    xh.style.display = "";
    xlabels.style.opacity = "0"; // the date pill takes over the axis row
    vl.setAttribute("x1", cx); vl.setAttribute("x2", cx);
    c1.setAttribute("cx", cx); c1.setAttribute("cy", y(p.portfolio - 100));
    c2.setAttribute("cx", cx); c2.setAttribute("cy", y(p.spy - 100));
    const label = fmtDay(p.date), pw = label.length * 7 + 14, px = Math.max(padL, Math.min(W - padR - pw, cx - pw / 2));
    pt.textContent = label; pt.setAttribute("x", px + pw / 2); pr.setAttribute("x", px); pr.setAttribute("width", pw);
    setReadout(p, usd(p.equity, 0));
    el.setAttribute("aria-valuenow", String(i));
    el.setAttribute("aria-valuetext", `${label}: Claude ${pct(p.portfolio - 100)}, SPY ${pct(p.spy - 100)}, equity ${usd(p.equity, 0)}`);
    S.scrubbing = true; syncFab();
  };
  const hide = () => {
    xh.style.display = "none"; xlabels.style.opacity = "";
    setReadout(null, range);
    el.setAttribute("aria-valuenow", String(n - 1)); el.setAttribute("aria-valuetext", summary);
    S.scrubbing = false; syncFab();
  };
  const at = (ev) => {
    const r = el.getBoundingClientRect();
    return Math.max(0, Math.min(n - 1, Math.round(((ev.clientX - r.left - padL) / (W - padL - padR)) * (n - 1))));
  };
  let ki = null;
  el.onpointermove = (e) => { ki = null; show(at(e)); };
  el.onpointerdown = (e) => { ki = null; show(at(e)); };
  el.onpointerleave = hide;
  el.onpointerup = (e) => { if (e.pointerType !== "mouse") hide(); };
  el.onpointercancel = hide;
  el.onblur = () => { ki = null; hide(); };
  el.onkeydown = (e) => {
    const moves = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -5, PageUp: 5 };
    if (e.key === "Escape") { if (ki != null) { ki = null; hide(); e.stopPropagation(); } return; }
    if (e.key in moves) ki = Math.max(0, Math.min(n - 1, (ki ?? n - 1) + moves[e.key]));
    else if (e.key === "Home") ki = 0;
    else if (e.key === "End") ki = n - 1;
    else return;
    e.preventDefault();
    show(ki);
  };
}

function slideTabs() {
  const tabs = document.querySelector(".tabs"), ind = tabs?.querySelector(".tab-ind");
  if (!ind) return;
  const place = (btn) => { ind.style.width = `${btn.offsetWidth}px`; ind.style.transform = `translateX(${btn.offsetLeft}px)`; };
  const cur = tabs.querySelector(`[data-period="${S.period}"]`), prev = S.prevPeriod && tabs.querySelector(`[data-period="${S.prevPeriod}"]`);
  ind.style.transition = "none";
  place(prev || cur);
  ind.getBoundingClientRect(); // commit the start position before animating
  ind.style.transition = "";
  place(cur);
  S.prevPeriod = S.period;
}

/* ---------- sheets ---------- */
let lastFocus = null;
const setInert = (on) => ["main", "fab"].forEach((id) => { const e = document.getElementById(id); if (e) e.inert = on; });
// focusSel: the field to focus with a keyboard and mouse. On touch, focus goes to the title so the keyboard doesn't jump up.
function openSheet(id, focusSel) {
  lastFocus = focusKey(document.activeElement);
  S.sheet = id;
  const sheet = document.getElementById(id);
  document.getElementById("scrim").classList.add("on");
  sheet.style.transform = "";
  sheet.style.setProperty("--kb", "0px");
  sheet.classList.add("on");
  document.body.style.overflow = "hidden";
  setInert(true);
  enableSwipe(sheet);
  const target = (finePointer && focusSel && sheet.querySelector(focusSel)) || sheet.querySelector("h3");
  target?.focus({ preventScroll: true });
}

// Drag the handle or header down to dismiss, like a native sheet.
function enableSwipe(sheet) {
  const zone = [sheet.querySelector(".grab"), sheet.querySelector(".sheet-h")].filter(Boolean);
  let startY = null, dy = 0, t0 = 0;
  const move = (e) => {
    if (startY == null) return;
    dy = Math.max(0, e.clientY - startY);
    sheet.style.transform = `translateY(${dy}px)`;
  };
  const up = () => {
    if (startY == null) return;
    const fast = dy / Math.max(1, performance.now() - t0) > 0.6;
    sheet.classList.remove("dragging");
    sheet.style.transform = "";
    if (dy > 110 || (fast && dy > 30)) closeSheet();
    startY = null; dy = 0;
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", up);
    removeEventListener("pointercancel", up);
  };
  zone.forEach((z) => (z.onpointerdown = (e) => {
    if (e.target.closest("button") || e.pointerType === "mouse") return;
    startY = e.clientY; t0 = performance.now(); dy = 0;
    sheet.classList.add("dragging");
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    addEventListener("pointercancel", up);
  }));
}
function closeSheet() {
  if (!S.sheet) return;
  document.getElementById(S.sheet).classList.remove("on");
  document.getElementById("scrim").classList.remove("on");
  document.body.style.overflow = "";
  S.sheet = null;
  setInert(false);
  refocus(lastFocus);
}

/* trade ticket */
const position = (sym) => S.data?.positions.find((p) => p.symbol === sym);
const estPrice = () => {
  const q = T.quote;
  if (T.type === "limit" && parseAmount(T.limit) > 0) return parseAmount(T.limit);
  if (!q || q.error) return null;
  return (T.side === "buy" ? q.ask : q.bid) || q.last || null;
};

function openTrade(symbol = "") {
  Object.assign(T, { symbol, side: "buy", size: "notional", type: "market", amount: "", limit: "", note: "", quote: null, review: false, busy: false, error: null });
  const el = document.getElementById("sheet-trade");
  el.innerHTML = `<div class="grab" aria-hidden="true"></div>
    <div class="sheet-h"><h3 id="t-title" tabindex="-1">${symbol ? `Trade <span class="mono">${esc(symbol)}</span>` : "New trade"}</h3><button class="icon-btn" data-close aria-label="Close">${I.close}</button></div>
    <div class="field"><label for="t-sym">Symbol</label><input class="input sym" id="t-sym" value="${esc(symbol)}" placeholder="SPY" maxlength="7" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" inputmode="text" enterkeyhint="next"><div id="t-quote" aria-live="polite"></div></div>
    <div class="field"><div class="side-toggle" role="group" aria-label="Side"><button class="b" data-side="buy" aria-pressed="true">Buy</button><button class="s" data-side="sell" aria-pressed="false">Sell</button></div></div>
    <div class="field"><div class="row2">
      <div><span class="lbl">Size in</span><div class="mini-seg" role="group" aria-label="Size in"><button data-size="notional" aria-pressed="true">Dollars</button><button data-size="qty" aria-pressed="false">Shares</button></div></div>
      <div><span class="lbl">Order</span><div class="mini-seg" role="group" aria-label="Order type"><button data-type="market" aria-pressed="true">Market</button><button data-type="limit" aria-pressed="false">Limit</button></div></div>
    </div></div>
    <div class="field"><label for="t-amt" id="t-amt-l">Amount</label><div class="affix"><span class="pre" id="t-pre" aria-hidden="true">$</span><input class="input big" id="t-amt" inputmode="decimal" placeholder="0" autocomplete="off" enterkeyhint="done"></div><div class="chips" id="t-chips"></div></div>
    <div class="field" id="t-lim-f" hidden><label for="t-lim">Limit price</label><div class="affix"><span class="pre" aria-hidden="true">$</span><input class="input big" id="t-lim" inputmode="decimal" placeholder="0.00" autocomplete="off" enterkeyhint="done"></div></div>
    <div class="field"><label for="t-note">Note <span style="text-transform:none;letter-spacing:0">(optional, logged)</span></label><input class="input" id="t-note" maxlength="500" placeholder="Why this trade?" autocomplete="off" enterkeyhint="done"></div>
    <div id="t-review"></div>`;
  wireTrade(el);
  openSheet("sheet-trade", symbol ? "#t-amt" : "#t-sym");
  refreshTicket();
  if (symbol) fetchQuote();
}

let quoteTimer;
// quiet: refresh the price in place (on Review) without the "Looking up" flash.
async function fetchQuote(quiet = false) {
  const sym = T.symbol;
  if (!/^[A-Z]{1,5}(\.[A-Z])?$/.test(sym)) { T.quote = null; return refreshTicket(); }
  const box = document.getElementById("t-quote");
  if (box && !quiet) box.innerHTML = `<div class="quote"><span class="n">Looking up ${esc(sym)}…</span></div>`;
  let q;
  try {
    const r = await api(`/quote?symbol=${encodeURIComponent(sym)}`, { timeout: 10_000 });
    q = r.status === 200 ? r.body
      : r.status < 500 ? { error: r.body.error || `${sym} isn't a known ticker.` }
      : { error: "Couldn't load a quote. You can still place the order.", soft: true };
  } catch (e) {
    q = { error: `Couldn't load a quote (${e.message.replace(/\.$/, "")}). You can still place the order.`, soft: true };
  }
  if (sym !== T.symbol || !S.sheet) return; // user kept typing, or closed the ticket
  T.quote = q;
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
  qb.innerHTML = !q ? "" : q.error ? `<div class="quote"><span class="n ${q.soft ? "" : "loss"}" style="white-space:normal">${esc(q.error)}</span></div>`
    : `<div class="quote"><span class="n">${esc(cleanName(q.name))}</span><span class="p">${q.last ? usd(q.last) : "–"}</span>
       <span class="m">${esc(q.category)} · bid ${q.bid ? usd(q.bid) : "–"} · ask ${q.ask ? usd(q.ask) : "–"}${pos ? ` · you hold ${shares(pos.qty)} sh` : ""}${q.tradable ? "" : ` · <span class="loss">not tradable here</span>`}</span></div>`;
  el.querySelectorAll("[data-side]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.side === T.side));
  el.querySelectorAll("[data-size]").forEach((b) => {
    b.setAttribute("aria-pressed", b.dataset.size === T.size);
    // Limit orders are sized in shares, so Dollars is off while Limit is picked.
    const off = b.dataset.size === "notional" && T.type === "limit";
    b.disabled = off;
    b.title = off ? "Limit orders are sized in shares" : "";
  });
  el.querySelectorAll("[data-type]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.type === T.type));
  el.querySelector("#t-pre").hidden = T.size !== "notional";
  el.querySelector("#t-amt").placeholder = T.size === "notional" ? "0" : "0 sh";
  el.querySelector("#t-amt").style.paddingLeft = T.size === "notional" ? "" : "14px";
  el.querySelector("#t-amt-l").textContent = T.size === "notional" ? "Amount in dollars" : "Number of shares";
  el.querySelector("#t-lim-f").hidden = T.type !== "limit";
  el.querySelector("#t-chips").innerHTML = chipsFor();
  renderReview();
}

function ticketProblem() {
  if (!/^[A-Z]{1,5}(\.[A-Z])?$/.test(T.symbol)) return "Enter a ticker, e.g. SPY.";
  if (T.quote?.error && !T.quote.soft) return T.quote.error;
  const amt = parseAmount(T.amount);
  if (T.amount && Number.isNaN(amt)) return "That amount isn't a number. Use digits and one decimal point.";
  if (!(amt > 0)) return T.size === "notional" ? "Enter an amount in dollars." : "Enter a number of shares.";
  if (T.type === "limit" && T.size === "notional") return "Limit orders are sized in shares. Switch to Shares.";
  const lim = parseAmount(T.limit);
  if (T.type === "limit" && !(lim > 0)) return "Enter a limit price.";
  return null;
}

// Largest order the max-order limit allows, with a little headroom for the price moving.
function maxOrderSize(price) {
  const cap = (S.data.account.equity * S.data.settings.maxOrderPct) / 100 * 0.99;
  if (T.size === "notional") return String(Math.floor(cap));
  if (!price) return null;
  const whole = T.type === "limit" || T.quote?.fractionable === false;
  const q = whole ? Math.floor(cap / price) : Math.floor((cap / price) * 1e4) / 1e4;
  return q > 0 ? String(q) : null;
}

function renderReview() {
  const box = document.getElementById("t-review");
  if (!box) return;
  const err = T.error ? alertHtml(T.error) : "";
  const sideCls = T.side === "buy" ? "buy" : "sell";
  if (!T.review) {
    box.innerHTML = `${err}<div class="actions"><button class="btn" id="t-go">Review order</button></div>`;
    if (T.error) scrollSheetEnd();
    return;
  }
  const price = estPrice(), amt = parseAmount(T.amount);
  const value = T.size === "notional" ? amt : price ? amt * price : null;
  const equity = S.data.account.equity, lim = S.data.settings;
  const pctEq = value != null ? (value / equity) * 100 : null;
  const over = T.side === "buy" && pctEq != null && pctEq > lim.maxOrderPct;
  const fit = over ? maxOrderSize(price) : null;
  const warn = over
    ? `<div class="alert err" role="alert"><b>Over your max order.</b> That's ${pctEq.toFixed(1)}% of equity and your limit is ${esc(lim.maxOrderPct)}%, so the server would block it.${fit ? `<br><button class="btn slim" id="t-fit">Use the max: ${T.size === "notional" ? usd(Number(fit), 0) : `${shares(Number(fit))} sh`}</button>` : ""}</div>` : "";
  box.innerHTML = `<div class="review"><dl>
      <dt>Order</dt><dd>${T.side === "buy" ? "Buy" : "Sell"} <span class="mono">${esc(T.symbol)}</span></dd>
      <dt>Size</dt><dd>${T.size === "notional" ? usd(amt) : `${shares(amt)} sh`}</dd>
      <dt>${T.type === "limit" ? "Limit" : "Est. price"}</dt><dd>${price ? usd(price) : "–"}</dd>
      <dt>Est. value</dt><dd>${value != null ? usd(value) : "–"}${pctEq != null ? ` <span class="mute">· ${pctEq.toFixed(1)}% of equity</span>` : ""}</dd>
      <dt>Type</dt><dd>${T.type === "limit" ? "Limit" : "Market"} · day · paper</dd>
    </dl></div>${warn}${err}
    <div class="actions">
      <button class="btn ${over ? "blocked" : sideCls}" id="t-confirm" ${T.busy || over ? "disabled" : ""}>${T.busy ? "Placing…" : over ? "Over your limit" : `Confirm ${T.side} · ${esc(T.symbol)}`}</button>
      <button class="btn ghost" id="t-edit" ${T.busy ? "disabled" : ""}>Edit</button>
    </div>`;
  scrollSheetEnd();
}
// The review, any warning and the buttons sit at the end of the ticket: bring all of them into view together.
function scrollSheetEnd() {
  const sh = document.getElementById("sheet-trade");
  sh?.scrollTo({ top: sh.scrollHeight, behavior: reducedMotion ? "auto" : "smooth" });
}

function wireTrade(el) {
  const sym = el.querySelector("#t-sym"), amt = el.querySelector("#t-amt"), lim = el.querySelector("#t-lim"), note = el.querySelector("#t-note");
  const title = el.querySelector("#t-title");
  sym.addEventListener("input", () => {
    sym.value = sym.value.toUpperCase().replace(/[^A-Z.]/g, "");
    T.symbol = sym.value; T.quote = null; T.review = false; T.error = null;
    title.textContent = "New trade";
    clearTimeout(quoteTimer);
    quoteTimer = setTimeout(fetchQuote, 420);
    refreshTicket();
  });
  const num = (inp, key) => inp.addEventListener("input", () => {
    inp.value = inp.value.replace(/[^0-9.,]/g, "");
    T[key] = inp.value;
    if (T.review || T.error) { T.review = false; T.error = null; renderReview(); }
  });
  num(amt, "amount"); num(lim, "limit");
  note.addEventListener("input", () => (T.note = note.value));
  // Enter in any field goes to Review (never straight to Confirm).
  el.querySelectorAll("input").forEach((inp) => inp.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || e.isComposing) return;
    e.preventDefault();
    if (inp === sym) return amt.focus();
    if (!T.review) el.querySelector("#t-go")?.click();
  }));
  const resetSize = () => { T.amount = ""; amt.value = ""; T.review = false; T.error = null; };
  el.onclick = async (e) => {
    const b = e.target.closest("button");
    if (!b || b.disabled) return;
    if (b.hasAttribute("data-close")) return closeSheet();
    if (b.dataset.side) {
      if (b.dataset.side === T.side) return;
      T.side = b.dataset.side;
      if (T.side === "sell" && position(T.symbol)) T.size = "qty";
      if (T.side === "buy" && T.type === "market") T.size = "notional";
      resetSize();
      return refreshTicket();
    }
    // Switching between dollars and shares clears the amount: "100" means something else in the other unit.
    if (b.dataset.size) { if (b.dataset.size !== T.size) { T.size = b.dataset.size; resetSize(); } return refreshTicket(); }
    if (b.dataset.type) {
      if (b.dataset.type === T.type) return;
      T.type = b.dataset.type;
      if (T.type === "limit" && T.size !== "qty") { T.size = "qty"; resetSize(); }
      T.review = false;
      return refreshTicket();
    }
    if (b.dataset.amt) { T.amount = b.dataset.amt; amt.value = T.amount; T.review = false; T.error = null; return renderReview(); }
    if (b.dataset.frac) {
      const p = position(T.symbol), f = Number(b.dataset.frac);
      T.size = "qty"; T.amount = String(f === 1 ? p.qty : Math.floor(p.qty * f * 1e6) / 1e6); amt.value = T.amount; T.review = false; T.error = null;
      return refreshTicket();
    }
    if (b.id === "t-go") {
      T.note = note.value.trim();
      const bad = ticketProblem();
      if (bad) { T.error = bad; return renderReview(); }
      T.error = null; T.review = true; renderReview();
      if (T.type === "market") fetchQuote(true); // re-price against a fresh quote before Confirm
      return;
    }
    if (b.id === "t-fit") {
      const v = maxOrderSize(estPrice());
      if (v) { T.amount = v; amt.value = v; renderReview(); }
      return;
    }
    if (b.id === "t-edit") { T.review = false; renderReview(); return amt.focus({ preventScroll: false }); }
    if (b.id === "t-confirm") return submitTrade();
  };
}

async function submitTrade() {
  if (T.busy) return; // a double tap must never send two orders
  T.busy = true; T.error = null; renderReview();
  const body = { symbol: T.symbol, side: T.side, order_type: T.type };
  if (T.size === "notional") body.notional = parseAmount(T.amount); else body.qty = parseAmount(T.amount);
  if (T.type === "limit") body.limit_price = parseAmount(T.limit);
  if (T.note) body.note = T.note;
  const sentAt = Date.now();
  let r;
  try {
    r = await api("/order", { method: "POST", body: JSON.stringify(body), timeout: 30_000 });
    if (!r.body.ok && r.status >= 500 && !r.body.message) throw new Error("The server hit an error.");
  } catch (err) {
    // We don't know whether the order reached the broker. Don't offer a one-tap retry: look it up first.
    T.busy = false; T.review = false;
    T.error = `${err.message} Checking whether the order went through…`;
    renderReview();
    await load().catch(() => {});
    const checked = S.tradesAt >= sentAt;
    const hit = checked && S.trades.find((t) => t.source === "manual" && t.symbol === body.symbol && t.side === body.side
      && new Date(t.created_at).getTime() >= sentAt - 5 * 60_000);
    T.error = hit
      ? `The connection dropped, but the order reached the server (${hit.status}). It's in your trade log, so don't place it again.`
      : checked
        ? `${err.message} The order isn't in your trade log, so it most likely wasn't placed. Review it again to retry.`
        : `${err.message} Couldn't check whether it went through. Close this and refresh before you try again.`;
    if (S.sheet === "sheet-trade") renderReview();
    return;
  }
  T.busy = false;
  if (!r.body.ok) { T.error = r.body.message || r.body.error || "Order failed."; return renderReview(); }
  const o = r.body.order;
  closeSheet();
  navigator.vibrate?.(12);
  toast(o.filled_qty
    ? `${o.side === "buy" ? "Bought" : "Sold"} ${shares(Number(o.filled_qty))} ${o.symbol} at ${usd(Number(o.filled_avg_price))}`
    : `${o.side === "buy" ? "Buy" : "Sell"} order for ${o.symbol} placed`);
  await load().catch((e) => toast(e.message, "err"));
}

/* limits & account */
function openLimits() {
  const s = S.data.settings, used = S.data.usage.mcp_orders_today;
  const el = document.getElementById("sheet-limits");
  const pctField = (id, label, v) => `<div class="field"><label for="${id}">${label}</label><div class="affix"><input class="input" id="${id}" inputmode="decimal" value="${esc(v)}" autocomplete="off" enterkeyhint="next" aria-describedby="${id}-u"><span class="pre" id="${id}-u" style="left:auto;right:14px;font:500 15px var(--sans)">% of equity</span></div></div>`;
  el.innerHTML = `<div class="grab" aria-hidden="true"></div>
    <div class="sheet-h"><h3 id="l-title" tabindex="-1">Limits</h3><button class="icon-btn" data-close aria-label="Close">${I.close}</button></div>
    <p class="hint" style="margin-top:-6px">Enforced on the server for every order, Claude's and yours. Claude has no tool to change them.</p>
    <form id="l-form" novalidate>
      <div class="row2">${pctField("l1", "Max order", s.maxOrderPct)}${pctField("l2", "Max position", s.maxPositionPct)}</div>
      <div class="field"><label for="l3">Claude orders per day</label><input class="input" id="l3" inputmode="numeric" value="${esc(s.maxOrdersPerDay)}" autocomplete="off" enterkeyhint="next" aria-describedby="l3-h">
        <div class="meter" aria-hidden="true"><i style="width:${Math.min(100, (used / Math.max(1, s.maxOrdersPerDay)) * 100)}%"></i></div>
        <div class="hint" id="l3-h">${esc(used)} used today. Your own trades don't count.</div></div>
      <div class="field"><label for="l4">Symbol allowlist</label><input class="input" id="l4" value="${esc(s.allowlist.join(", "))}" placeholder="Empty means any US stock or ETF" autocapitalize="characters" autocorrect="off" spellcheck="false" autocomplete="off" enterkeyhint="done"></div>
      <div id="l-msg"></div>
      <div class="actions"><button class="btn" type="submit" id="l-save">Save limits</button></div>
    </form>
    <div class="who-line"><span>Signed in as <b style="color:var(--ink);font-weight:500">${esc(S.login)}</b></span><button class="chip flat" style="border:0" id="logout">Sign out</button></div>`;
  openSheet("sheet-limits", "#l1");
  el.querySelector("[data-close]").onclick = closeSheet;
  el.querySelector("#logout").onclick = async () => { await sb.auth.signOut().catch(() => {}); location.reload(); };
  el.querySelector("#l-form").onsubmit = async (e) => {
    e.preventDefault();
    const save = el.querySelector("#l-save"), msg = el.querySelector("#l-msg");
    if (save.disabled) return;
    const v = (id) => el.querySelector(id).value.trim();
    save.disabled = true; save.textContent = "Saving…"; msg.innerHTML = "";
    try {
      const r = await api("/settings", { method: "PUT", body: JSON.stringify({ maxOrderPct: v("#l1"), maxPositionPct: v("#l2"), maxOrdersPerDay: v("#l3"), allowlist: v("#l4") }) });
      if (!r.body.ok) throw new Error(r.body.message || "Could not save.");
      S.data.settings = r.body.settings;
      closeSheet();
      toast("Limits saved");
    } catch (err) {
      msg.innerHTML = alertHtml(err.message);
      save.disabled = false; save.textContent = "Save limits";
    }
  };
}

/* ---------- data ---------- */
async function loadHistory(period) {
  const r = await api(`/history?period=${period}`);
  if (r.status !== 200) throw new Error(r.body.error || "Couldn't load the chart history.");
  S.history[period] = r.body.points ?? [];
}

// Every call keeps the last good data if its own request fails, and a slow response never overwrites a newer one.
let loadSeq = 0;
async function load() {
  const seq = ++loadSeq;
  const soft = (pr) => pr.catch(() => null);
  const [p, t, n] = await Promise.all([
    api("/portfolio"), soft(api("/trades?limit=40")), soft(api("/notes?limit=20")),
    soft(loadHistory(S.period)), soft(loadHistory("all")),
  ]);
  if (seq !== loadSeq) return;
  if (p.status !== 200) throw new Error(p.body.error || "Could not load the portfolio.");
  S.data = p.body;
  if (t?.status === 200) { S.trades = t.body.trades ?? []; S.tradesAt = Date.now(); }
  if (n?.status === 200) S.notes = n.body.notes ?? [];
  S.updatedAt = Date.now();
  renderMain();
}

/* ---------- events on the main view ---------- */
function wireMain() {
  const main = document.getElementById("main");
  main.addEventListener("click", async (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    if (b.id === "refresh") {
      if (b.classList.contains("spin")) return;
      b.classList.add("spin");
      try { await load(); toast("Up to date"); } catch (err) { toast(err.message, "err"); }
      document.getElementById("refresh")?.classList.remove("spin");
      return;
    }
    if (b.id === "limits") return openLimits();
    if (b.id === "bar-trade") return openTrade();
    if (b.id === "tape") {
      const now = performance.now();
      if (S.tapePaused) S.tapeT0 = now - S.tapeAt * 1000;
      else S.tapeAt = (now - S.tapeT0) / 1000;
      S.tapePaused = !S.tapePaused;
      b.classList.toggle("paused", S.tapePaused);
      b.setAttribute("aria-pressed", S.tapePaused);
      return;
    }
    if (b.dataset.period) {
      if (b.dataset.period === S.period) return;
      const prev = S.period;
      S.period = b.dataset.period;
      if (!S.history[S.period]) {
        try { await loadHistory(S.period); } catch (err) { S.period = prev; toast(err.message, "err"); return; }
      }
      S.animateChart = true;
      return renderMain();
    }
    if (b.dataset.feed) { S.feed = b.dataset.feed; return renderMain(); }
    if (b.dataset.sym) return openTrade(b.dataset.sym);
    if (b.dataset.more) {
      const k = b.dataset.more, open = !S.open.has(k);
      open ? S.open.add(k) : S.open.delete(k);
      document.getElementById(`b-${k}`)?.classList.toggle("clamp", !open);
      b.setAttribute("aria-expanded", open);
      b.textContent = open ? "Show less" : "Read more";
      return;
    }
    if (b.dataset.cancel) {
      if (!confirm("Cancel this order?")) return;
      b.disabled = true;
      try {
        const r = await api("/cancel", { method: "POST", body: JSON.stringify({ order_id: b.dataset.cancel }) });
        toast(r.body.ok ? "Order canceled" : r.body.message || "Cancel failed", r.body.ok ? "ok" : "err");
      } catch (err) { toast(err.message, "err"); }
      return load().catch((err) => toast(err.message, "err"));
    }
  });
  let resizeTimer;
  addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(mountChart, 120); });
  // Remember the last touch, scroll or key, so a quiet refresh never rebuilds the page under a finger.
  const touch = () => (S.lastInput = Date.now());
  ["pointerdown", "keydown", "wheel", "scroll", "touchmove"].forEach((t) => addEventListener(t, touch, { passive: true, capture: true }));
  const due = () => {
    const m = S.data?.market;
    return m && (m.is_open || Date.now() >= new Date(m.next_open).getTime());
  };
  const quiet = (force = false) => {
    if (S.expired || document.hidden || S.sheet || S.scrubbing || !S.data) return;
    if (!force && Date.now() - S.lastInput < 10_000) return;
    load().catch(() => {});
  };
  // Every minute while the market is open (or should have just opened).
  setInterval(() => { if (due()) quiet(); }, 60_000);
  // Coming back to the tab after a while: catch up straight away.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && Date.now() - (S.updatedAt ?? 0) > 60_000) quiet(true);
  });
}

function skeletonHtml() {
  const sk = (w, h, r = 8, extra = "") => `<span class="sk" style="width:${w};height:${h}px;border-radius:${r}px;${extra}"></span>`;
  const card = (h) => `<section class="card sk-card">${sk("38%", 10)}${sk("100%", h, 12, "margin-top:18px")}</section>`;
  return `<header class="bar"><div class="mark">${I.mark}<span>Portfolio</span></div><div class="bar-right">${sk("74px", 30, 99)}</div></header>
    <div class="top"><section class="hero" aria-busy="true" aria-label="Loading">${sk("110px", 10)}${sk("min(78%, 420px)", 72, 14, "margin:16px 0 14px;display:block")}${sk("180px", 26)}</section>${card(96)}</div>
    <div class="grid"><div class="col">${card(230)}${card(180)}</div><div class="col">${card(80)}${card(160)}</div></div>`;
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
  document.getElementById("main").innerHTML = skeletonHtml();
  try {
    await load();
  } catch (err) {
    if (S.expired) return;
    const main = document.getElementById("main");
    main.innerHTML = `<div class="skeleton" style="text-transform:none;letter-spacing:0;font:14px var(--sans);gap:14px"><span class="loss" role="alert">${esc(err.message)}</span><button class="chip flat" style="border:0" id="retry">Try again</button></div>`;
    main.querySelector("#retry").onclick = () => location.reload();
  }
}
boot();

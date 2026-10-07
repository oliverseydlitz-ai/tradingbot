import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, ALLOWED_GITHUB_LOGIN } from "/config.js";

const API = `${SUPABASE_URL}/functions/v1/mcp/api`;
const sb = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
const app = document.getElementById("app");

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const usd = (n, d = 2) => (n < 0 ? "-" : "") + "$" + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
const sgn = (n) => (n > 0 ? "+" : n < 0 ? "−" : "");
const pct = (n, d = 2) => `${sgn(n)}${Math.abs(n).toFixed(d)}%`;
const arrow = (n) => (n > 0 ? "▲" : n < 0 ? "▼" : "•");
const tone = (n) => (n > 0 ? "gain" : n < 0 ? "loss" : "mut");
const pl = (n, p) => `<span class="${tone(n)}">${arrow(n)} ${sgn(n)}${usd(Math.abs(n))} (${pct(p)})</span>`;

const state = { data: null, trades: [], notes: [], history: [], period: "1M", chartTable: false, ticket: { side: "buy", size: "notional", type: "market" }, quote: null, review: null, msg: null, settingsMsg: null };

async function api(path, opts = {}) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) throw new Error("Signed out");
  const res = await fetch(API + path, {
    ...opts,
    headers: { authorization: `Bearer ${session.access_token}`, "content-type": "application/json" },
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) {
    await sb.auth.signOut();
    location.reload();
  }
  return { status: res.status, body };
}

/* ---------- gate ---------- */
function renderGate(note) {
  app.innerHTML = `<div class="center"><h1>Portfolio</h1><p class="mut">Paper-trading dashboard</p>
    ${note ? `<p class="loss">${esc(note)}</p>` : ""}
    <button class="primary" id="login">Sign in with GitHub</button></div>`;
  document.getElementById("login").onclick = () =>
    sb.auth.signInWithOAuth({ provider: "github", options: { redirectTo: location.origin + "/" } });
}

/* ---------- chart ---------- */
function chartSvg(points) {
  if (points.length < 2) return `<p class="mut">Not enough history yet. The curve appears once there are two or more trading days.</p>`;
  const W = 640, H = 240, L = 44, R = 12, T = 10, B = 24;
  const vals = points.flatMap((p) => [p.portfolio, p.spy]);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = Math.max((hi - lo) * 0.1, 0.2);
  lo -= pad; hi += pad;
  const x = (i) => L + (i / (points.length - 1)) * (W - L - R);
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const line = (k) => points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p[k]).toFixed(1)}`).join(" ");
  const ticks = [lo + pad, (lo + hi) / 2, hi - pad].map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="var(--mut)">${pct(v - 100, 1)}</text>`).join("");
  const first = points[0].date, last = points.at(-1).date;
  return `<div class="chart" id="chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Portfolio versus SPY, indexed to 100">
    ${ticks}
    <path d="${line("spy")}" fill="none" stroke="var(--s2)" stroke-width="2" stroke-linejoin="round"/>
    <path d="${line("portfolio")}" fill="none" stroke="var(--s1)" stroke-width="2" stroke-linejoin="round"/>
    <text x="${L}" y="${H - 6}" font-size="11" fill="var(--mut)">${esc(first)}</text>
    <text x="${W - R}" y="${H - 6}" text-anchor="end" font-size="11" fill="var(--mut)">${esc(last)}</text>
    <line id="cx" y1="${T}" y2="${H - B}" stroke="var(--mut)" stroke-dasharray="3 3" style="display:none"/>
    <circle id="d1" r="4" fill="var(--s1)" stroke="var(--surface)" stroke-width="2" style="display:none"/>
    <circle id="d2" r="4" fill="var(--s2)" stroke="var(--surface)" stroke-width="2" style="display:none"/>
    <rect id="hit" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent"/>
  </svg><div class="tip" id="tip"></div></div>`;
}

function wireChart(points) {
  const chart = document.getElementById("chart");
  if (!chart) return;
  const svg = chart.querySelector("svg"), hit = chart.querySelector("#hit"), tip = chart.querySelector("#tip");
  const W = 640, H = 240, L = 44, R = 12, T = 10, B = 24;
  const vals = points.flatMap((p) => [p.portfolio, p.spy]);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = Math.max((hi - lo) * 0.1, 0.2);
  lo -= pad; hi += pad;
  const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
  const move = (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(points.length - 1, Math.round(((px - L) / (W - L - R)) * (points.length - 1))));
    const p = points[i], cx = L + (i / (points.length - 1)) * (W - L - R);
    const set = (id, a) => Object.entries(a).forEach(([k, v]) => svg.querySelector(id).setAttribute(k, v));
    set("#cx", { x1: cx, x2: cx });
    set("#d1", { cx, cy: y(p.portfolio) });
    set("#d2", { cx, cy: y(p.spy) });
    svg.querySelectorAll("#cx,#d1,#d2").forEach((e) => (e.style.display = "block"));
    tip.style.display = "block";
    tip.innerHTML = `<b>${esc(p.date)}</b><br><span class="sw" style="background:var(--s1)"></span>Portfolio ${pct(p.portfolio - 100)} · ${usd(p.equity, 0)}<br><span class="sw" style="background:var(--s2)"></span>SPY ${pct(p.spy - 100)}`;
    const left = (cx / W) * r.width;
    tip.style.left = Math.min(Math.max(left - 70, 0), r.width - 190) + "px";
    tip.style.top = "0px";
  };
  hit.addEventListener("pointermove", move);
  hit.addEventListener("pointerdown", move);
  hit.addEventListener("pointerleave", () => {
    tip.style.display = "none";
    svg.querySelectorAll("#cx,#d1,#d2").forEach((e) => (e.style.display = "none"));
  });
}

const chartTable = (pts) => `<table><thead><tr><th>Date</th><th>Equity</th><th>Portfolio</th><th>SPY</th></tr></thead><tbody>${pts
  .slice().reverse().map((p) => `<tr><td>${esc(p.date)}</td><td>${usd(p.equity, 0)}</td><td>${pct(p.portfolio - 100)}</td><td>${pct(p.spy - 100)}</td></tr>`).join("")}</tbody></table>`;

/* ---------- sections ---------- */
function kpis(d) {
  const a = d.account;
  return `<div class="kpis">
    <div class="kpi"><div class="l">Equity</div><div class="v">${usd(a.equity, 0)}</div></div>
    <div class="kpi"><div class="l">Today</div><div class="v ${tone(a.day_pl)}">${arrow(a.day_pl)} ${pct(a.day_pl_pct)}</div><div class="sub ${tone(a.day_pl)}">${sgn(a.day_pl)}${usd(Math.abs(a.day_pl))}</div></div>
    <div class="kpi"><div class="l">Cash</div><div class="v">${usd(a.cash, 0)}</div></div>
    <div class="kpi"><div class="l">Positions</div><div class="v">${d.positions.length}</div></div></div>`;
}

function chartCard() {
  const pts = state.history;
  const last = pts.at(-1);
  const periods = ["1W", "1M", "3M", "6M", "1A", "all"];
  return `<div class="card"><div class="row"><h2>Portfolio vs SPY (indexed)</h2>
    <div class="seg" role="group" aria-label="Period">${periods.map((p) => `<button data-period="${p}" aria-pressed="${p === state.period}">${p}</button>`).join("")}</div></div>
    <div class="legend"><span><span class="sw" style="background:var(--s1)"></span>Portfolio${last ? ` ${pct(last.portfolio - 100)}` : ""}</span><span><span class="sw" style="background:var(--s2)"></span>SPY${last ? ` ${pct(last.spy - 100)}` : ""}</span>
    <button class="sm" id="toggleTable" style="margin-left:auto">${state.chartTable ? "Chart" : "Table"}</button></div>
    ${state.chartTable ? chartTable(pts) : chartSvg(pts)}</div>`;
}

function allocationCard(d) {
  const colors = ["var(--s1)", "var(--s2)", "var(--s3)", "var(--s4)"];
  const total = d.allocation.reduce((s, a) => s + a.value, 0) || 1;
  return `<div class="card"><h2>Allocation</h2>
    <div class="bar" role="img" aria-label="Allocation">${d.allocation.map((a, i) => (a.value > 0 ? `<i style="width:${(a.value / total) * 100}%;background:${colors[i]}" title="${esc(a.label)}"></i>` : "")).join("")}</div>
    <div class="legend" style="display:grid;grid-template-columns:1fr 1fr;gap:6px 14px">${d.allocation.map((a, i) => `<span><span class="sw" style="background:${colors[i]}"></span>${esc(a.label)} <b class="num">${((a.value / total) * 100).toFixed(1)}%</b> <span class="mut num">${usd(a.value, 0)}</span></span>`).join("")}</div>
    <p class="hint">Bonds appear as bond ETFs (TLT, BND, AGG…); Alpaca has no direct bond trading. Crypto is excluded by design.</p></div>`;
}

function performers(d) {
  const max = Math.max(1, ...d.positions.map((p) => Math.abs(p.unrealized_pl_pct)));
  const col = (title, rows) => `<div><h2>${title}</h2>${rows.length ? rows.map((p) => `<div class="pr"><span class="sym">${esc(p.symbol)}</span>
    <div class="t"><b style="left:${p.unrealized_pl_pct >= 0 ? 50 : 50 - (Math.abs(p.unrealized_pl_pct) / max) * 50}%;width:${(Math.abs(p.unrealized_pl_pct) / max) * 50}%;background:${p.unrealized_pl_pct >= 0 ? "var(--gain)" : "var(--loss)"}"></b></div>
    <span class="num ${tone(p.unrealized_pl)}">${arrow(p.unrealized_pl)} ${pct(p.unrealized_pl_pct, 1)}</span></div>`).join("") : `<p class="mut">No positions yet.</p>`}</div>`;
  return `<div class="card"><div class="perf">${col("Best performers", d.performers.best)}${col("Worst performers", d.performers.worst)}</div><p class="hint">Unrealized return since entry.</p></div>`;
}

function positionsCard(d) {
  if (!d.positions.length) return `<div class="card"><h2>Positions</h2><p class="mut">No open positions.</p></div>`;
  return `<div class="card"><h2>Positions</h2><table><thead><tr><th>Symbol</th><th>Value</th><th>P&amp;L</th></tr></thead><tbody>${d.positions.map((p) => `<tr>
    <td><div class="sym">${esc(p.symbol)} <button class="sm" data-trade="${esc(p.symbol)}" style="min-height:26px;padding:0 8px">Trade</button></div><div class="sub">${esc(p.category)} · ${p.qty.toLocaleString("en-US", { maximumFractionDigits: 4 })} sh</div></td>
    <td>${usd(p.market_value)}<div class="sub">${p.weight_pct.toFixed(1)}% of equity</div></td>
    <td class="${tone(p.unrealized_pl)}" style="white-space:nowrap">${arrow(p.unrealized_pl)} ${sgn(p.unrealized_pl)}${usd(Math.abs(p.unrealized_pl))}<div class="sub"><span>${pct(p.unrealized_pl_pct)}</span> · <span class="${tone(p.day_pl)}">today ${pct(p.day_pl_pct)}</span></div></td></tr>`).join("")}</tbody></table></div>`;
}

const quoteHtml = (q) => !q ? "" : q.error ? esc(q.error) : `${esc(q.name)} · ${esc(q.category)}${q.tradable ? "" : " · <b class=loss>not tradable here</b>"}<br>Last ${q.last ? usd(q.last) : "–"} · Bid ${q.bid ? usd(q.bid) : "–"} · Ask ${q.ask ? usd(q.ask) : "–"}`;

function ticketCard() {
  const t = state.ticket, q = state.quote;
  const seg = (key, opts) => `<div class="seg" role="group">${opts.map(([v, l]) => `<button type="button" data-seg="${key}:${v}" aria-pressed="${t[key] === v}">${l}</button>`).join("")}</div>`;
  const rv = state.review;
  return `<div class="card" id="ticket"><h2>Trade ticket</h2>
    <form id="tform" autocomplete="off">
      <label for="tsym">Symbol</label><input id="tsym" value="${esc(t.symbol ?? "")}" placeholder="e.g. SPY, TLT, SPCX" maxlength="7" autocapitalize="characters" spellcheck="false">
      <p class="hint" id="qhint">${quoteHtml(q)}</p>
      <div class="row" style="margin-top:10px">${seg("side", [["buy", "Buy"], ["sell", "Sell"]])}${seg("size", [["notional", "Dollars"], ["qty", "Shares"]])}${seg("type", [["market", "Market"], ["limit", "Limit"]])}</div>
      <div class="grid2"><div><label for="tamt">${t.size === "notional" ? "Amount ($)" : "Shares"}</label><input id="tamt" inputmode="decimal" value="${esc(t.amount ?? "")}" placeholder="${t.size === "notional" ? "100" : "1"}"></div>
      ${t.type === "limit" ? `<div><label for="tlim">Limit price ($)</label><input id="tlim" inputmode="decimal" value="${esc(t.limit ?? "")}"></div>` : "<div></div>"}</div>
      <label for="tnote">Note (optional, saved in the log)</label><input id="tnote" value="${esc(t.note ?? "")}" maxlength="500">
      ${t.type === "limit" && t.size === "notional" ? `<p class="hint loss">Limit orders need a share quantity. Switch to Shares.</p>` : ""}
      ${rv ? `<div class="msg" style="background:var(--grid)"><b>Confirm:</b> ${esc(rv.text)}<div class="row" style="margin-top:10px;justify-content:flex-start"><button type="button" class="primary" id="confirm">Place order</button><button type="button" id="cancelReview">Edit</button></div></div>` : `<button class="primary" style="width:100%;margin-top:12px" type="submit">Review order</button>`}
    </form>${state.msg ? `<div class="msg ${state.msg.ok ? "ok" : "err"}">${esc(state.msg.text)}</div>` : ""}
    <p class="hint">Paper account. Orders go through the same server-side guardrails as Claude's, are day orders, and are logged. The market must be open.</p></div>`;
}

function ordersCard(d) {
  if (!d.open_orders.length) return "";
  return `<div class="card"><h2>Open orders</h2><div class="list">${d.open_orders.map((o) => `<div class="row it"><span><b>${esc(o.side.toUpperCase())} ${esc(o.symbol)}</b> ${o.qty ? o.qty + " sh" : usd(o.notional)} ${esc(o.type)}${o.limit_price ? " @ " + usd(o.limit_price) : ""}<div class="sub">${esc(o.status)}</div></span><button class="sm" data-cancel="${esc(o.id)}">Cancel</button></div>`).join("")}</div></div>`;
}

function notesCard() {
  const n = state.notes;
  return `<div class="card"><h2>Claude's notes</h2>${n.length ? n.map((x, i) => `<details class="it" ${i === 0 ? "open" : ""} style="padding:9px 0;border-top:${i ? "1px solid var(--line)" : "0"}"><summary style="cursor:pointer;font-size:.85rem"><b>${esc(x.title || "Note")}</b> <span class="sub">${esc(x.note_date)}</span>${(x.tags || []).map((t) => `<span class="badge">${esc(t)}</span>`).join("")}</summary><div style="white-space:pre-wrap;font-size:.85rem;margin-top:6px">${esc(x.body)}</div></details>`).join("") : `<p class="mut">No notes yet. Claude saves one at the end of each run.</p>`}</div>`;
}

function logCard() {
  return `<div class="card"><h2>Trade log</h2><div class="list">${state.trades.length ? state.trades.map((t) => `<div class="it"><div class="row"><span><b>${esc(t.side.toUpperCase())} ${esc(t.symbol)}</b> ${t.qty ? t.qty + " sh" : usd(t.notional)}<span class="badge">${esc(t.source)}</span><span class="badge">${esc(t.status)}</span></span><span class="sub">${esc(new Date(t.created_at).toLocaleString())}</span></div>
    <div class="sub">${esc(t.reason)}${t.error ? `<br><span class="loss">${esc(t.error)}</span>` : ""}</div></div>`).join("") : `<p class="mut">No trades yet.</p>`}</div></div>`;
}

function limitsCard(d) {
  const s = d.settings;
  return `<div class="card"><h2>Limits</h2><form id="sform">
    <div class="grid2"><div><label for="s1">Max order (% of equity)</label><input id="s1" inputmode="decimal" value="${s.maxOrderPct}"></div>
    <div><label for="s2">Max position (% of equity)</label><input id="s2" inputmode="decimal" value="${s.maxPositionPct}"></div></div>
    <div class="grid2"><div><label for="s3">Max Claude orders / day</label><input id="s3" inputmode="numeric" value="${s.maxOrdersPerDay}"></div>
    <div><label for="s4">Symbol allowlist (empty = any)</label><input id="s4" value="${esc(s.allowlist.join(", "))}" placeholder="SPY, QQQ, TLT"></div></div>
    <button class="primary" style="margin-top:12px" type="submit">Save limits</button></form>
    ${state.settingsMsg ? `<div class="msg ${state.settingsMsg.ok ? "ok" : "err"}">${esc(state.settingsMsg.text)}</div>` : ""}
    <p class="hint">Claude orders today: <b>${d.usage.mcp_orders_today}/${s.maxOrdersPerDay}</b>. The daily cap counts Claude's orders only; the other limits apply to you as well. Claude has no tool to change any of this. Order and position limits are capped at 100%.</p></div>`;
}

/* ---------- render ---------- */
function render() {
  const d = state.data;
  app.innerHTML = `<div class="top"><div><h1>Portfolio</h1><span class="pill ${d.market.is_open ? "open" : "closed"}">${d.market.is_open ? "Market open" : "Market closed"}</span></div><div class="row" style="gap:8px;flex-wrap:nowrap"><button class="sm" id="refresh">Refresh</button><button class="sm" id="logout">Sign out</button></div></div>
    ${kpis(d)}${chartCard()}${allocationCard(d)}${performers(d)}${positionsCard(d)}${ticketCard()}${ordersCard(d)}${limitsCard(d)}${notesCard()}${logCard()}`;
  if (!state.chartTable) wireChart(state.history);
}

async function loadHistory() {
  const r = await api(`/history?period=${state.period}`);
  state.history = r.body.points ?? [];
}

async function load() {
  const [p, t, n] = await Promise.all([api("/portfolio"), api("/trades?limit=30"), api("/notes?limit=10")]);
  if (p.status !== 200) throw new Error(p.body.error || "Could not load portfolio");
  state.data = p.body;
  state.trades = t.body.trades ?? [];
  state.notes = n.body.notes ?? [];
  await loadHistory();
  render();
}

/* ---------- events ---------- */
const val = (id) => document.getElementById(id)?.value ?? "";
function readTicket() {
  const t = state.ticket;
  t.symbol = val("tsym").trim().toUpperCase();
  t.amount = val("tamt");
  t.limit = val("tlim");
  t.note = val("tnote");
}

async function fetchQuote() {
  const sym = state.ticket.symbol;
  if (!sym) { state.quote = null; return; }
  const r = await api(`/quote?symbol=${encodeURIComponent(sym)}`);
  state.quote = r.status === 200 ? r.body : { error: r.body.error || "Unknown symbol" };
}

function orderBody() {
  const t = state.ticket;
  const amt = Number(t.amount);
  const body = { symbol: t.symbol, side: t.side, order_type: t.type };
  if (t.size === "notional") body.notional = amt; else body.qty = amt;
  if (t.type === "limit") body.limit_price = Number(t.limit);
  if (t.note) body.note = t.note;
  return body;
}

function validateTicket() {
  const t = state.ticket;
  if (!/^[A-Z]{1,5}(\.[A-Z])?$/.test(t.symbol || "")) return "Enter a valid ticker.";
  if (!(Number(t.amount) > 0)) return "Enter an amount greater than 0.";
  if (t.type === "limit" && t.size === "notional") return "Limit orders need a share quantity. Switch to Shares.";
  if (t.type === "limit" && !(Number(t.limit) > 0)) return "Enter a limit price.";
  return null;
}

app.addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  try {
    if (b.id === "login") return;
    if (b.id === "logout") { await sb.auth.signOut(); return location.reload(); }
    if (b.id === "refresh") { b.disabled = true; await load(); return; }
    if (b.id === "toggleTable") { state.chartTable = !state.chartTable; return render(); }
    if (b.dataset.period) { state.period = b.dataset.period; await loadHistory(); return render(); }
    if (b.dataset.seg) {
      readTicket();
      const [k, v] = b.dataset.seg.split(":");
      state.ticket[k] = v; state.review = null; state.msg = null;
      return render();
    }
    if (b.dataset.trade) {
      Object.assign(state.ticket, { symbol: b.dataset.trade, side: "sell", size: "qty", type: "market", amount: "", note: "" });
      state.review = null; state.msg = null;
      await fetchQuote(); render();
      return document.getElementById("ticket").scrollIntoView({ behavior: "smooth" });
    }
    if (b.dataset.cancel) {
      if (!confirm("Cancel this order?")) return;
      const r = await api("/cancel", { method: "POST", body: JSON.stringify({ order_id: b.dataset.cancel }) });
      state.msg = { ok: r.body.ok, text: r.body.ok ? "Order cancelled." : r.body.message || "Cancel failed." };
      return load();
    }
    if (b.id === "cancelReview") { state.review = null; return render(); }
    if (b.id === "confirm") {
      b.disabled = true;
      const r = await api("/order", { method: "POST", body: JSON.stringify(orderBody()) });
      state.review = null;
      state.msg = r.body.ok
        ? { ok: true, text: `Order ${r.body.order.status}: ${r.body.order.side} ${r.body.order.symbol}${r.body.order.filled_qty ? `, filled ${r.body.order.filled_qty} @ ${usd(r.body.order.filled_avg_price)}` : ""}.` }
        : { ok: false, text: r.body.message || r.body.error || "Order failed." };
      if (r.body.ok) Object.assign(state.ticket, { amount: "", note: "" });
      return load();
    }
  } catch (err) {
    state.msg = { ok: false, text: err.message };
    render();
  }
});

app.addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    if (e.target.id === "tform") {
      readTicket();
      const bad = validateTicket();
      if (bad) { state.msg = { ok: false, text: bad }; return render(); }
      state.msg = null;
      const t = state.ticket;
      const size = t.size === "notional" ? usd(Number(t.amount)) : `${Number(t.amount)} sh`;
      state.review = { text: `${t.side.toUpperCase()} ${size} of ${t.symbol} at ${t.type === "limit" ? "limit " + usd(Number(t.limit)) : "market"} (day order, paper)` };
      return render();
    }
    if (e.target.id === "sform") {
      const body = { maxOrderPct: val("s1"), maxPositionPct: val("s2"), maxOrdersPerDay: val("s3"), allowlist: val("s4") };
      const r = await api("/settings", { method: "PUT", body: JSON.stringify(body) });
      state.settingsMsg = r.body.ok ? { ok: true, text: "Limits saved." } : { ok: false, text: r.body.message || "Could not save." };
      if (r.body.ok) state.data.settings = r.body.settings;
      return render();
    }
  } catch (err) {
    state.msg = { ok: false, text: err.message };
    render();
  }
});

app.addEventListener("focusout", async (e) => {
  if (e.target.id === "tsym") {
    readTicket();
    await fetchQuote();
    const h = document.getElementById("qhint");
    if (h) h.innerHTML = quoteHtml(state.quote); // update in place so a tap on the next field isn't lost
  }
});

/* ---------- boot ---------- */
async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return renderGate();
  const login = String(session.user.user_metadata?.user_name ?? "").toLowerCase();
  if (login !== ALLOWED_GITHUB_LOGIN.toLowerCase()) {
    await sb.auth.signOut();
    return renderGate(`GitHub account "${login}" is not allowed.`);
  }
  try {
    await load();
  } catch (err) {
    app.innerHTML = `<div class="center"><p class="loss">${esc(err.message)}</p><button id="refresh2">Retry</button></div>`;
    document.getElementById("refresh2").onclick = () => location.reload();
  }
}
boot();

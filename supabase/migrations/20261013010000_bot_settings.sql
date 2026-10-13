-- Telegram bot settings (edited on the dashboard) and price alerts.
alter table public.settings
  add column approval_pct double precision not null default 5 check (approval_pct >= 0 and approval_pct <= 100), -- 0 = never ask
  add column notify_claude_trades boolean not null default true,
  add column notify_fills boolean not null default false,
  add column mover_alert_pct double precision not null default 0 check (mover_alert_pct >= 0 and mover_alert_pct <= 100), -- 0 = off
  add column claude_paused boolean not null default false,
  add column last_fill_check timestamptz,
  add column movers_sent jsonb;

create table public.alerts (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  symbol text not null,
  op text not null check (op in ('above','below')),
  price double precision not null check (price > 0),
  active boolean not null default true,
  triggered_at timestamptz,
  triggered_price double precision
);
create index alerts_active_idx on public.alerts (active) where active;

alter table public.alerts enable row level security;
revoke all on public.alerts from anon, authenticated;

-- Applied to project kdbmfnybaqcgluxqhntp via the Supabase connector (migration "init_trading_log").
create table public.trades (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  trade_date date not null,                -- America/New_York calendar date, drives the daily order cap
  symbol text not null,
  side text not null check (side in ('buy','sell')),
  qty double precision,
  notional double precision,
  order_type text not null check (order_type in ('market','limit')),
  limit_price double precision,
  alpaca_order_id text,
  status text not null check (status in ('pending','accepted','canceled','failed','rejected')),
  reason text not null,
  equity_at_time double precision,
  error text
);
create index trades_trade_date_idx on public.trades (trade_date);
create index trades_symbol_idx on public.trades (symbol, id desc);

create table public.snapshots (
  date date primary key,                   -- America/New_York calendar date
  equity double precision not null,
  cash double precision not null,
  spy_close double precision
);

-- Locked down: only the edge function (service role) touches these. No policies = no access for anon/authenticated.
alter table public.trades enable row level security;
alter table public.snapshots enable row level security;
revoke all on public.trades, public.snapshots from anon, authenticated;

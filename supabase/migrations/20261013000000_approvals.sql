-- Big orders from Claude wait here until you tap Yes/No in Telegram.
create table public.approvals (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  status text not null default 'pending' check (status in ('pending','approved','declined','failed')),
  symbol text not null,
  side text not null check (side in ('buy','sell')),
  qty double precision,
  notional double precision,
  order_type text not null check (order_type in ('market','limit')),
  limit_price double precision,
  reason text not null,
  est_notional double precision not null,
  equity_at_time double precision,
  decided_at timestamptz,
  result text
);

alter table public.approvals enable row level security;
revoke all on public.approvals from anon, authenticated;

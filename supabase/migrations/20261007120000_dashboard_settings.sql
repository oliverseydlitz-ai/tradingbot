-- Dashboard support: editable limits + order source.
alter table public.trades
  add column source text not null default 'mcp' check (source in ('mcp','manual'));

create table public.settings (
  id int primary key default 1 check (id = 1),           -- single row
  max_order_pct double precision not null default 10 check (max_order_pct > 0 and max_order_pct <= 100),
  max_position_pct double precision not null default 20 check (max_position_pct > 0 and max_position_pct <= 100),
  max_orders_per_day int not null default 10 check (max_orders_per_day between 1 and 100),
  symbol_allowlist text not null default '',
  updated_at timestamptz not null default now()
);
insert into public.settings (id) values (1);

alter table public.settings enable row level security;
revoke all on public.settings from anon, authenticated;

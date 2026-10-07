-- Claude's persistent notes between scheduled runs.
create table public.notes (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  note_date date not null,                 -- America/New_York calendar date
  title text check (title is null or char_length(title) <= 120),
  body text not null check (char_length(body) between 1 and 8000),
  tags text[] not null default '{}'
);
create index notes_created_idx on public.notes (id desc);
create index notes_tags_idx on public.notes using gin (tags);

alter table public.notes enable row level security;
revoke all on public.notes from anon, authenticated;

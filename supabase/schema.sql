-- Schema applied to the Supabase project (migrations init_karaoke + advance_queue_fn).
-- Kept here for reference / to recreate the database.

create table public.settings (
  id int primary key default 1 check (id = 1),
  max_duration_sec int not null default 360 check (max_duration_sec between 60 and 1800),
  require_approval boolean not null default true,
  updated_at timestamptz not null default now()
);
insert into public.settings (id) values (1);

create table public.singers (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 40),
  token_hash text not null unique,
  status text not null default 'pending' check (status in ('pending','approved','blocked')),
  created_at timestamptz not null default now()
);

create table public.queue (
  id bigint generated always as identity primary key,
  singer_id uuid not null references public.singers(id) on delete cascade,
  video_id text not null check (char_length(video_id) between 5 and 20),
  title text not null,
  thumbnail text,
  duration_sec int not null,
  status text not null default 'waiting' check (status in ('waiting','playing','done','skipped')),
  position double precision not null default extract(epoch from now()),
  created_at timestamptz not null default now(),
  started_at timestamptz
);
create index queue_active_idx on public.queue (status, position) where status in ('waiting','playing');
create index queue_singer_idx on public.queue (singer_id);
create unique index queue_one_active_per_singer on public.queue (singer_id) where status in ('waiting','playing');
create unique index queue_one_playing on public.queue ((true)) where status = 'playing';

alter table public.settings enable row level security;
alter table public.singers enable row level security;
alter table public.queue enable row level security;

create policy "public read settings" on public.settings for select to anon, authenticated using (true);
create policy "public read singers" on public.singers for select to anon, authenticated using (true);
create policy "public read queue" on public.queue for select to anon, authenticated using (true);

revoke insert, update, delete on public.settings, public.singers, public.queue from anon, authenticated;
revoke select on public.singers from anon, authenticated;
grant select (id, name, status, created_at) on public.singers to anon, authenticated;

alter publication supabase_realtime add table public.settings, public.singers, public.queue;

create or replace function public.advance_queue(p_current bigint, p_end_status text default 'done')
returns bigint language plpgsql security definer set search_path = public as $$
declare v_playing bigint; v_next bigint;
begin
  if p_end_status not in ('done','skipped') then raise exception 'invalid status'; end if;
  perform pg_advisory_xact_lock(424242);
  select id into v_playing from queue where status = 'playing' limit 1;
  if v_playing is not null and (p_current is null or v_playing <> p_current) then return v_playing; end if;
  if v_playing is not null then update queue set status = p_end_status where id = v_playing; end if;
  select q.id into v_next from queue q join singers s on s.id = q.singer_id
  where q.status = 'waiting' and s.status = 'approved' order by q.position, q.id limit 1;
  if v_next is not null then update queue set status = 'playing', started_at = now() where id = v_next; end if;
  return v_next;
end; $$;
revoke all on function public.advance_queue(bigint, text) from public, anon, authenticated;

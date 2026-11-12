-- v3: reações no telão e modo campeonato.
-- Só ADICIONA coisas (tabelas, colunas com valor padrão e funções novas). Não muda nem apaga
-- nada que já existe, então a versão antiga do app continua funcionando depois de rodar.

-- ---------- campeonatos ----------
create table if not exists public.contests (
  id bigint generated always as identity primary key,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  results jsonb -- preenchido quando o campeonato termina
);
create unique index if not exists contests_one_active on public.contests ((true)) where ended_at is null;
alter table public.contests enable row level security;
drop policy if exists "public read contests" on public.contests;
create policy "public read contests" on public.contests for select to anon, authenticated using (true);
revoke insert, update, delete on public.contests from anon, authenticated;
grant select on public.contests to anon, authenticated;

alter table public.settings
  add column if not exists contest_id bigint references public.contests(id) on delete set null,
  add column if not exists results_contest_id bigint references public.contests(id) on delete set null,
  add column if not exists reactions_enabled boolean not null default true;

-- ---------- votos (secretos: só o servidor lê) ----------
create table if not exists public.votes (
  id bigint generated always as identity primary key,
  contest_id bigint not null references public.contests(id) on delete cascade,
  queue_id bigint not null references public.queue(id) on delete cascade,
  voter_id uuid not null references public.singers(id) on delete cascade,
  score int not null check (score between 1 and 5),
  created_at timestamptz not null default now(),
  unique (queue_id, voter_id)
);
create index if not exists votes_contest_idx on public.votes (contest_id);
create index if not exists votes_voter_idx on public.votes (voter_id);
alter table public.votes enable row level security;
revoke all on public.votes from anon, authenticated;

-- ---------- reações (o telão escuta os INSERTs por Realtime) ----------
create table if not exists public.reactions (
  id bigint generated always as identity primary key,
  queue_id bigint not null references public.queue(id) on delete cascade,
  emoji text not null check (emoji in ('clap', 'heart', 'fire', 'cry')),
  created_at timestamptz not null default now()
);
create index if not exists reactions_created_idx on public.reactions (created_at);
create index if not exists reactions_queue_idx on public.reactions (queue_id);
alter table public.reactions enable row level security;
drop policy if exists "public read reactions" on public.reactions;
create policy "public read reactions" on public.reactions for select to anon, authenticated using (true);
revoke insert, update, delete on public.reactions from anon, authenticated;
grant select on public.reactions to anon, authenticated;

do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'reactions') then
    alter publication supabase_realtime add table public.reactions;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'contests') then
    alter publication supabase_realtime add table public.contests;
  end if;
end $$;

-- ---------- funções (chamadas só pelo servidor, com a chave secreta) ----------

-- Cliente manda uma reação para quem está cantando. Uma ida ao banco só.
create or replace function public.send_reaction(p_token_hash text, p_emoji text)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_id uuid; v_status text; v_playing bigint; v_recent int;
begin
  select id, status into v_id, v_status from singers where token_hash = p_token_hash;
  if v_id is null then return 'unknown'; end if;
  if v_status <> 'approved' then return v_status; end if;
  if not coalesce((select reactions_enabled from settings where id = 1), false) then return 'off'; end if;
  select id into v_playing from queue where status = 'playing' limit 1;
  if v_playing is null then return 'idle'; end if;
  -- no máximo 8 reações a cada 10 segundos por pessoa
  select count(*) into v_recent from rate_events where key = 'react:' || v_id and at > now() - interval '10 seconds';
  if v_recent >= 8 then return 'slow'; end if;
  insert into rate_events (key) values ('react:' || v_id);
  insert into reactions (queue_id, emoji) values (v_playing, p_emoji);
  if random() < 0.01 then
    delete from reactions where created_at < now() - interval '1 day';
    delete from rate_events where at < now() - interval '1 day';
  end if;
  return 'ok';
end; $$;

-- Cliente dá nota (1 a 5) para quem está cantando agora. Pode trocar até a música acabar.
create or replace function public.cast_vote(p_token_hash text, p_score int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_id uuid; v_status text; v_contest bigint; v_queue bigint; v_performer uuid;
begin
  if p_score is null or p_score < 1 or p_score > 5 then return jsonb_build_object('status', 'invalid'); end if;
  select id, status into v_id, v_status from singers where token_hash = p_token_hash;
  if v_id is null then return jsonb_build_object('status', 'unknown'); end if;
  if v_status <> 'approved' then return jsonb_build_object('status', v_status); end if;
  select contest_id into v_contest from settings where id = 1;
  if v_contest is null then return jsonb_build_object('status', 'no_contest'); end if;
  select id, singer_id into v_queue, v_performer from queue where status = 'playing' limit 1;
  if v_queue is null then return jsonb_build_object('status', 'idle'); end if;
  if v_performer = v_id then return jsonb_build_object('status', 'self'); end if;
  insert into votes (contest_id, queue_id, voter_id, score) values (v_contest, v_queue, v_id, p_score)
  on conflict (queue_id, voter_id) do update set score = excluded.score, contest_id = excluded.contest_id, created_at = now();
  return jsonb_build_object('status', 'ok', 'queue_id', v_queue, 'score', p_score);
end; $$;

-- Classificação de um campeonato: uma linha por apresentação, melhor nota média primeiro.
-- Empate: quem teve mais votos; depois, quem cantou antes.
create or replace function public.contest_standings(p_contest bigint)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(to_jsonb(r) - 'started_at' order by r.score desc nulls last, r.votes desc, r.started_at, r.queue_id), '[]'::jsonb)
  from (
    select q.id as queue_id, s.name, q.title, q.video_id,
           count(v.id)::int as votes,
           round(avg(v.score), 2)::float as score,
           q.started_at
    from contests c
    join queue q on q.started_at is not null
    join singers s on s.id = q.singer_id
    left join votes v on v.queue_id = q.id and v.contest_id = c.id
    where c.id = p_contest
    group by q.id, s.name, c.started_at, c.ended_at
    having count(v.id) > 0
        or (q.status in ('playing', 'done') and q.started_at >= c.started_at and (c.ended_at is null or q.started_at <= c.ended_at))
  ) r;
$$;

-- Admin liga o campeonato. Se já existe um ativo, devolve o mesmo.
create or replace function public.start_contest()
returns bigint language plpgsql security definer set search_path = public as $$
declare v_id bigint;
begin
  perform pg_advisory_xact_lock(424243);
  select id into v_id from contests where ended_at is null limit 1;
  if v_id is null then
    insert into contests default values returning id into v_id;
  end if;
  update settings set contest_id = v_id, results_contest_id = null where id = 1;
  return v_id;
end; $$;

-- Admin encerra: fecha a votação, grava o resultado e manda o telão mostrar.
create or replace function public.end_contest()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_id bigint; v_results jsonb;
begin
  perform pg_advisory_xact_lock(424243);
  select id into v_id from contests where ended_at is null limit 1;
  if v_id is null then return null; end if;
  update contests set ended_at = now() where id = v_id;
  v_results := contest_standings(v_id);
  update contests set results = v_results where id = v_id;
  update settings set contest_id = null, results_contest_id = v_id where id = 1;
  return v_results;
end; $$;

revoke all on function public.send_reaction(text, text) from public, anon, authenticated;
revoke all on function public.cast_vote(text, int) from public, anon, authenticated;
revoke all on function public.contest_standings(bigint) from public, anon, authenticated;
revoke all on function public.start_contest() from public, anon, authenticated;
revoke all on function public.end_contest() from public, anon, authenticated;
grant execute on function public.send_reaction(text, text) to service_role;
grant execute on function public.cast_vote(text, int) to service_role;
grant execute on function public.contest_standings(bigint) to service_role;
grant execute on function public.start_contest() to service_role;
grant execute on function public.end_contest() to service_role;

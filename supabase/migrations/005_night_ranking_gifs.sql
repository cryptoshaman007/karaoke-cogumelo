-- v5: zerar a noite, ranking da noite (nota pelas reações) e GIFs/figurinhas no telão.
-- Só ADICIONA coisas (colunas com valor padrão, uma tabela, funções e um gatilho). A única função
-- que já existia e é trocada é send_reaction, com a mesma assinatura: ela passa a guardar quem
-- reagiu. A versão antiga do app continua funcionando depois de rodar.

-- ---------- colunas novas ----------
alter table public.settings
  add column if not exists ranking_enabled boolean not null default false,
  add column if not exists ranking_on_tv boolean not null default false,
  add column if not exists gifs_enabled boolean not null default true,
  -- quando a noite atual começou (o ranking da noite conta a partir daqui)
  add column if not exists night_started_at timestamptz not null default now(),
  -- hora do dia (horário de Brasília) em que a fila da noite passada é zerada sozinha. null = desligado
  add column if not exists night_reset_hour int default 12 check (night_reset_hour between 0 and 23);

alter table public.queue
  add column if not exists score numeric(3,1) check (score between 0 and 10),
  add column if not exists reaction_count int;
create index if not exists queue_score_idx on public.queue (started_at desc) where score is not null;

alter table public.reactions
  add column if not exists singer_id uuid references public.singers(id) on delete set null;

-- ---------- GIFs e figurinhas (o telão escuta os INSERTs por Realtime) ----------
create table if not exists public.tv_gifs (
  id bigint generated always as identity primary key,
  singer_id uuid references public.singers(id) on delete set null,
  name text not null check (char_length(name) between 1 and 40),
  kind text not null check (kind in ('gif', 'sticker')),
  ref text not null check (char_length(ref) between 1 and 300), -- endereço do GIF ou nome da figurinha
  created_at timestamptz not null default now()
);
create index if not exists tv_gifs_created_idx on public.tv_gifs (created_at);
alter table public.tv_gifs enable row level security;
do $$
begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'tv_gifs' and policyname = 'public read tv_gifs') then
    create policy "public read tv_gifs" on public.tv_gifs for select to anon, authenticated using (true);
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'tv_gifs') then
    alter publication supabase_realtime add table public.tv_gifs;
  end if;
end $$;
revoke insert, update, delete on public.tv_gifs from anon, authenticated;
grant select on public.tv_gifs to anon, authenticated;

-- ---------- funções ----------

-- Igual à anterior, mas guarda quem reagiu (para a nota contar pessoas, não toques repetidos).
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
  insert into reactions (queue_id, emoji, singer_id) values (v_playing, p_emoji, v_id);
  if random() < 0.01 then
    delete from reactions where created_at < now() - interval '2 days';
    delete from rate_events where at < now() - interval '1 day';
  end if;
  return 'ok';
end; $$;

-- Cliente manda um GIF ou uma figurinha para o telão. Um a cada 12 segundos por pessoa.
create or replace function public.send_gif(p_token_hash text, p_kind text, p_ref text)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_id uuid; v_status text; v_name text; v_recent int;
begin
  if p_kind not in ('gif', 'sticker') or p_ref is null or char_length(p_ref) not between 1 and 300 then return 'invalid'; end if;
  select id, status, name into v_id, v_status, v_name from singers where token_hash = p_token_hash;
  if v_id is null then return 'unknown'; end if;
  if v_status <> 'approved' then return v_status; end if;
  if not coalesce((select gifs_enabled from settings where id = 1), false) then return 'off'; end if;
  select count(*) into v_recent from rate_events where key = 'gif:' || v_id and at > now() - interval '12 seconds';
  if v_recent >= 1 then return 'slow'; end if;
  insert into rate_events (key) values ('gif:' || v_id);
  insert into tv_gifs (singer_id, name, kind, ref) values (v_id, v_name, p_kind, p_ref);
  if random() < 0.05 then
    delete from tv_gifs where created_at < now() - interval '1 day';
  end if;
  return 'ok';
end; $$;

-- Ranking da noite: quando uma música termina, a nota (5,0 a 10,0) sai das reações que ela recebeu.
-- Conta PESSOAS que reagiram (toques repetidos da mesma pessoa valem cada vez menos) e compara com
-- o tamanho da plateia que está reagindo na noite. Quem canta não conta para a própria nota.
-- Não dá nota durante um campeonato (lá valem os votos) nem para música pulada no começo.
-- Qualquer erro aqui é ignorado: a fila nunca deixa de andar por causa da nota.
create or replace function public.score_song()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_on boolean; v_contest bigint; v_night timestamptz;
  v_pts double precision; v_total int; v_crowd int; v_k double precision;
begin
  begin
    select ranking_enabled, contest_id, night_started_at into v_on, v_contest, v_night from settings where id = 1;
    if not coalesce(v_on, false) or v_contest is not null then return new; end if;
    if new.started_at is null then return new; end if;
    if new.status = 'skipped' and now() - new.started_at < interval '60 seconds' then return new; end if;

    select coalesce(sum(sqrt(least(t.c, 9))), 0), coalesce(sum(t.c), 0)::int into v_pts, v_total
    from (
      select count(*) as c from reactions r
      where r.queue_id = new.id and (r.singer_id is null or r.singer_id <> new.singer_id)
      group by coalesce(r.singer_id::text, r.id::text)
    ) t;

    select count(distinct r.singer_id) into v_crowd from reactions r
    where r.created_at >= coalesce(v_night, now() - interval '12 hours')
      and r.singer_id is not null and r.singer_id <> new.singer_id;

    v_k := greatest(3, v_crowd * 0.75);
    new.score := least(10, round((5 + 5 * (1 - exp(-v_pts / v_k)))::numeric, 1));
    new.reaction_count := v_total;
  exception when others then
    null;
  end;
  return new;
end; $$;

drop trigger if exists queue_score_song on public.queue;
create trigger queue_score_song
  before update of status on public.queue
  for each row
  when (old.status = 'playing' and new.status in ('done', 'skipped'))
  execute function public.score_song();

-- Zera a noite: tira da fila tudo o que está esperando ou tocando, encerra campeonato aberto,
-- limpa o que estava no telão e começa um ranking novo.
-- p_auto = true é a limpeza automática: só age se já passou da hora configurada desde a última
-- vez E se ninguém cantou nos últimos 45 minutos (o bar ainda aberto nunca perde a fila).
-- Devolve 'reset', 'off' (automático desligado), 'fresh' (ainda não é hora) ou 'busy' (bar ativo).
create or replace function public.reset_night(p_auto boolean default false)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_night timestamptz; v_hour int; v_local timestamp; v_boundary timestamp; v_contest bigint;
begin
  perform pg_advisory_xact_lock(424242); -- a mesma trava do advance_queue: os dois nunca se cruzam
  if p_auto then
    select night_started_at, night_reset_hour into v_night, v_hour from settings where id = 1;
    if v_hour is null then return 'off'; end if;
    v_local := now() at time zone 'America/Sao_Paulo';
    v_boundary := date_trunc('day', v_local) + make_interval(hours => v_hour);
    if v_boundary > v_local then v_boundary := v_boundary - interval '1 day'; end if;
    if v_night >= (v_boundary at time zone 'America/Sao_Paulo') then return 'fresh'; end if;
    if exists (select 1 from queue where started_at > now() - interval '45 minutes') then return 'busy'; end if;
  end if;

  update queue set status = 'skipped' where status in ('waiting', 'playing');

  select id into v_contest from contests where ended_at is null limit 1;
  if v_contest is not null then
    update contests set ended_at = now() where id = v_contest;
    update contests set results = contest_standings(v_contest) where id = v_contest;
  end if;

  update settings set
    contest_id = null,
    results_contest_id = null,
    ranking_on_tv = false,
    paused = false,
    night_started_at = now(),
    queue_open = case when p_auto then true else queue_open end,
    updated_at = now()
  where id = 1;
  return 'reset';
end; $$;

revoke all on function public.send_gif(text, text, text) from public, anon, authenticated;
revoke all on function public.score_song() from public, anon, authenticated;
revoke all on function public.reset_night(boolean) from public, anon, authenticated;
grant execute on function public.send_gif(text, text, text) to service_role;
grant execute on function public.reset_night(boolean) to service_role;

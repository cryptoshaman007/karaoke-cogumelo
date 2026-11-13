-- v7: correções da revisão de bugs (13/11/2026).
-- Só ADICIONA coisas (tabelas novas, funções novas e um índice) e troca o corpo de funções que já
-- existem mantendo a mesma assinatura. A versão antiga do app continua funcionando depois de rodar,
-- e a versão nova do app funciona antes de rodar (cai no jeito antigo).

-- ---------- limite de tentativas em um passo só ----------
-- Conta e registra na mesma transação, com uma trava por chave: 300 pedidos ao mesmo tempo não
-- passam mais todos pela contagem. Devolve true quando o pedido pode seguir.
create or replace function public.rate_hit(p_key text, p_max int, p_window_sec int)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_count int;
begin
  if p_key is null or p_max is null or p_window_sec is null then return false; end if;
  perform pg_advisory_xact_lock(hashtext('rate:' || p_key));
  select count(*) into v_count from rate_events
  where key = p_key and at > now() - make_interval(secs => p_window_sec);
  if v_count >= p_max then return false; end if;
  insert into rate_events (key) values (p_key);
  if random() < 0.01 then
    delete from rate_events where at < now() - interval '1 day';
  end if;
  return true;
end; $$;
revoke all on function public.rate_hit(text, int, int) from public, anon, authenticated;
grant execute on function public.rate_hit(text, int, int) to service_role;

-- ---------- sessão do admin ----------
-- Cada login ganha um crachá aleatório. "Sair" apaga o crachá daquele aparelho e "Sair de todos os
-- aparelhos" apaga todos. Só o servidor acessa.
create table if not exists public.admin_sessions (
  token_hash text primary key,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists admin_sessions_expires_idx on public.admin_sessions (expires_at);
alter table public.admin_sessions enable row level security; -- sem política: só a chave secreta
revoke all on public.admin_sessions from anon, authenticated;

-- ---------- um telão só no comando ----------
-- O telão que está tocando renova a posse a cada poucos segundos. Outro aparelho que abrir a
-- tela do projetor vira espelho (sem vídeo), a não ser que alguém clique em "assumir o telão".
-- Tabela separada de settings de propósito: o batimento não acorda os celulares pelo Realtime.
create table if not exists public.tv_lock (
  id int primary key default 1 check (id = 1),
  owner text,
  seen_at timestamptz
);
insert into public.tv_lock (id) values (1) on conflict do nothing;
alter table public.tv_lock enable row level security;
revoke all on public.tv_lock from anon, authenticated;

-- Devolve true quando p_id é (ou passa a ser) o telão no comando.
create or replace function public.claim_tv(p_id text, p_force boolean default false)
returns boolean language plpgsql security definer set search_path = public as $$
declare v_owner text; v_seen timestamptz;
begin
  if p_id is null or char_length(p_id) not between 8 and 64 then return false; end if;
  select owner, seen_at into v_owner, v_seen from tv_lock where id = 1 for update;
  if not found then
    insert into tv_lock (id, owner, seen_at) values (1, p_id, now()) on conflict (id) do update set owner = p_id, seen_at = now();
    return true;
  end if;
  if p_force or v_owner is null or v_owner = p_id or v_seen is null or v_seen < now() - interval '30 seconds' then
    update tv_lock set owner = p_id, seen_at = now() where id = 1;
    return true;
  end if;
  return false;
end; $$;
revoke all on function public.claim_tv(text, boolean) from public, anon, authenticated;
grant execute on function public.claim_tv(text, boolean) to service_role;

-- ---------- GIF e reação: trava por pessoa ----------
-- Mesmas funções da 005, agora com uma trava por pessoa: pedidos simultâneos não furam o limite.
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
  perform pg_advisory_xact_lock(hashtext('gif:' || v_id));
  select count(*) into v_recent from rate_events where key = 'gif:' || v_id and at > now() - interval '12 seconds';
  if v_recent >= 1 then return 'slow'; end if;
  insert into rate_events (key) values ('gif:' || v_id);
  insert into tv_gifs (singer_id, name, kind, ref) values (v_id, v_name, p_kind, p_ref);
  if random() < 0.05 then
    delete from tv_gifs where created_at < now() - interval '1 day';
  end if;
  return 'ok';
end; $$;

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
  perform pg_advisory_xact_lock(hashtext('react:' || v_id));
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

-- ---------- limpeza automática da noite: mais cuidadosa ----------
-- Igual à 005, mas também conta como "bar ativo" um pedido de música feito nos últimos 45 minutos
-- (uma pausa longa com gente na fila não apaga mais a fila). E a limpeza automática não apaga a
-- selfie de quem acabou de chegar: só as fotos com mais de 1 hora.
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
    if exists (select 1 from queue where started_at > now() - interval '45 minutes')
       or exists (select 1 from queue where status = 'waiting' and created_at > now() - interval '45 minutes') then
      return 'busy';
    end if;
    -- lido pelo gatilho das fotos (006): guarda as selfies recentes
    perform set_config('karaoke.keep_recent_photos', '1', true);
  end if;

  if to_regclass('public.reserves') is not null then
    execute 'delete from public.reserves where true';
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
revoke all on function public.reset_night(boolean) from public, anon, authenticated;
grant execute on function public.reset_night(boolean) to service_role;

create or replace function public.clear_photos_on_new_night()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if coalesce(current_setting('karaoke.keep_recent_photos', true), '') = '1' then
    with gone as (
      delete from singer_photos where created_at < now() - interval '1 hour' returning singer_id
    )
    update singers set photo_at = null where id in (select singer_id from gone);
  else
    delete from singer_photos where true;
    update singers set photo_at = null where photo_at is not null;
  end if;
  return new;
end; $$;
revoke all on function public.clear_photos_on_new_night() from public, anon, authenticated;

-- ---------- classificação do campeonato: só o período dele ----------
-- Igual à 003, mas olha só as músicas do período do campeonato em vez de todo o histórico.
create index if not exists queue_started_idx on public.queue (started_at) where started_at is not null;
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
                and q.started_at >= c.started_at - interval '1 day'
                and (c.ended_at is null or q.started_at <= c.ended_at)
    join singers s on s.id = q.singer_id
    left join votes v on v.queue_id = q.id and v.contest_id = c.id
    where c.id = p_contest
    group by q.id, s.name, c.started_at, c.ended_at
    having count(v.id) > 0
        or (q.status in ('playing', 'done') and q.started_at >= c.started_at and (c.ended_at is null or q.started_at <= c.ended_at))
  ) r;
$$;
revoke all on function public.contest_standings(bigint) from public, anon, authenticated;
grant execute on function public.contest_standings(bigint) to service_role;

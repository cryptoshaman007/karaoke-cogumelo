-- 009: "Zerar a noite" e a limpeza automática falhavam no Supabase.
-- O Supabase liga a extensão pg_safeupdate para as chamadas da API, e ela recusa DELETE sem WHERE
-- ("DELETE requires a WHERE clause"). Por isso reset_night dava erro toda vez: o botão do admin
-- avisava que não deu, e a fila da noite anterior ficava lá quando o telão abria.
-- Mesma lógica da 007, só com "where true" nos dois DELETE sem filtro. Pode rodar mais de uma vez.

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

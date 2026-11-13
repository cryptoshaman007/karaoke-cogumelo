-- v4: mais de uma música por pessoa (com revezamento) e botão de adicionar pedido no telão.
-- Só ADICIONA coisas (duas colunas com valor padrão, uma tabela e duas funções). Não muda nem
-- apaga nada que já existe, então a versão antiga do app continua funcionando depois de rodar.

alter table public.settings
  add column if not exists tv_add_enabled boolean not null default true,
  add column if not exists songs_per_person int not null default 1 check (songs_per_person between 1 and 3);

-- Músicas de reserva: a pessoa já tem uma na fila e deixou outra(s) guardada(s). Cada reserva só
-- entra na fila, no fim, quando a música anterior da pessoa sai (cantou, foi pulada ou tirada).
-- Assim ninguém canta duas seguidas. Só o servidor acessa esta tabela.
create table if not exists public.reserves (
  id bigint generated always as identity primary key,
  singer_id uuid not null references public.singers(id) on delete cascade,
  video_id text not null check (char_length(video_id) between 5 and 20),
  title text not null,
  thumbnail text,
  duration_sec int not null,
  created_at timestamptz not null default now()
);
create index if not exists reserves_singer_idx on public.reserves (singer_id, id);
alter table public.reserves enable row level security;
revoke all on public.reserves from anon, authenticated;

-- Coloca uma música para a pessoa: na fila se ela não tem nenhuma, de reserva se já tem e o
-- limite por pessoa permite. Devolve 'queued', 'reserved' ou 'full'.
create or replace function public.enqueue_song(
  p_singer uuid, p_video_id text, p_title text, p_thumbnail text, p_duration_sec int
) returns text language plpgsql security definer set search_path = public as $$
declare v_active int; v_reserved int; v_max int;
begin
  perform pg_advisory_xact_lock(424242);
  select count(*) into v_active from queue where singer_id = p_singer and status in ('waiting', 'playing');
  if v_active = 0 then
    insert into queue (singer_id, video_id, title, thumbnail, duration_sec, position)
    values (p_singer, p_video_id, p_title, p_thumbnail, p_duration_sec, extract(epoch from clock_timestamp()));
    return 'queued';
  end if;
  select coalesce(songs_per_person, 1) into v_max from settings where id = 1;
  select count(*) into v_reserved from reserves where singer_id = p_singer;
  if v_active + v_reserved >= coalesce(v_max, 1) then return 'full'; end if;
  insert into reserves (singer_id, video_id, title, thumbnail, duration_sec)
  values (p_singer, p_video_id, p_title, p_thumbnail, p_duration_sec);
  return 'reserved';
end; $$;

-- Para cada pessoa que tem reserva e ficou sem música na fila, a reserva mais antiga entra no
-- fim da fila. Devolve quantas entraram. Pode ser chamada quantas vezes for: não duplica nada.
create or replace function public.promote_reserves()
returns int language plpgsql security definer set search_path = public as $$
declare v_count int;
begin
  perform pg_advisory_xact_lock(424242);
  with pick as (
    select distinct on (r.singer_id) r.id, r.singer_id, r.video_id, r.title, r.thumbnail, r.duration_sec
    from reserves r
    join singers s on s.id = r.singer_id
    where s.status <> 'blocked'
      and not exists (select 1 from queue q where q.singer_id = r.singer_id and q.status in ('waiting', 'playing'))
    order by r.singer_id, r.id
  ), ins as (
    insert into queue (singer_id, video_id, title, thumbnail, duration_sec, position)
    select singer_id, video_id, title, thumbnail, duration_sec,
           extract(epoch from clock_timestamp()) + row_number() over (order by id) * 0.001
    from pick
    returning 1
  ), del as (
    delete from reserves where id in (select id from pick) returning 1
  )
  select (select count(*) from ins) into v_count from (select count(*) from del) d;
  return v_count;
end; $$;

revoke all on function public.enqueue_song(uuid, text, text, text, int) from public, anon, authenticated;
revoke all on function public.promote_reserves() from public, anon, authenticated;
grant execute on function public.enqueue_song(uuid, text, text, text, int) to service_role;
grant execute on function public.promote_reserves() to service_role;

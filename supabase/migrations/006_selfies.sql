-- v6: selfie opcional de quem canta (aparece no telão, na fila, no ranking e na figurinha da nota).
-- Só ADICIONA coisas. Pode rodar antes ou depois da 005; a versão antiga do app continua funcionando.
--
-- A foto fica numa tabela que só o servidor lê (o telão pega pela rota /api/photo). Ela é apagada
-- quando a noite é zerada, quando a pessoa ou o admin apaga, e de qualquer jeito depois de 18 horas.

alter table public.settings
  add column if not exists photos_enabled boolean not null default true;

-- quando a pessoa tirou a foto (null = sem foto). O telão usa para saber se há foto e trocar a imagem.
alter table public.singers
  add column if not exists photo_at timestamptz;
grant select (photo_at) on public.singers to anon, authenticated;

create table if not exists public.singer_photos (
  singer_id uuid primary key references public.singers(id) on delete cascade,
  jpeg text not null check (char_length(jpeg) <= 120000), -- JPEG pequeno em base64 (~60 KB no máximo)
  created_at timestamptz not null default now()
);
create index if not exists singer_photos_created_idx on public.singer_photos (created_at);
alter table public.singer_photos enable row level security; -- sem política: só a chave secreta do servidor lê
revoke all on public.singer_photos from anon, authenticated;

-- Noite zerada (migração 005 muda settings.night_started_at): as fotos da noite vão embora junto.
create or replace function public.clear_photos_on_new_night()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  delete from singer_photos where true;
  update singers set photo_at = null where photo_at is not null;
  return new;
end; $$;
revoke all on function public.clear_photos_on_new_night() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from information_schema.columns
             where table_schema = 'public' and table_name = 'settings' and column_name = 'night_started_at')
     and not exists (select 1 from pg_trigger where tgname = 'settings_new_night_photos') then
    create trigger settings_new_night_photos
      after update of night_started_at on public.settings
      for each row when (old.night_started_at is distinct from new.night_started_at)
      execute function public.clear_photos_on_new_night();
  end if;
end $$;

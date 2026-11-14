-- v12: extensão do Chrome do telão (vídeos que só tocam no youtube.com).
-- Só ADICIONA colunas:
--   * settings.yt_extension: o admin liga/desliga o uso da extensão (começa ligado).
--   * tv_lock.ext_version / ext_seen_at: o telão no comando conta se tem a extensão, pro admin ver.
--     Fica em tv_lock (e não em settings) pra não acordar os celulares pelo Realtime.

alter table public.settings add column if not exists yt_extension boolean not null default true;
alter table public.tv_lock add column if not exists ext_version text;
alter table public.tv_lock add column if not exists ext_seen_at timestamptz;

-- v2: controle remoto do telão, fila aberta/fechada, recado no telão e limite de tentativas.
-- Só ADICIONA coisas (colunas com valor padrão, uma tabela e índices). Não muda nem apaga
-- nada que já existe, então a versão antiga do app continua funcionando depois de rodar.

alter table public.settings
  add column if not exists queue_open boolean not null default true,
  add column if not exists intermission_sec int not null default 8 check (intermission_sec between 0 and 30),
  add column if not exists tv_message text not null default '' check (char_length(tv_message) <= 140),
  add column if not exists paused boolean not null default false,
  add column if not exists volume int not null default 100 check (volume between 0 and 100),
  add column if not exists restart_at timestamptz;

-- contador de tentativas (login do admin, entradas, buscas). Só o servidor acessa.
create table if not exists public.rate_events (
  id bigint generated always as identity primary key,
  key text not null,
  at timestamptz not null default now()
);
create index if not exists rate_events_key_at_idx on public.rate_events (key, at);
alter table public.rate_events enable row level security;
revoke all on public.rate_events from anon, authenticated;

create index if not exists queue_done_idx on public.queue (id desc) where status = 'done';
create index if not exists singers_status_idx on public.singers (status, created_at desc);

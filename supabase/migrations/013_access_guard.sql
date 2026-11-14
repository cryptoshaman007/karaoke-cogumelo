-- v13: proteção contra bots e gente de fora.
-- Só ADICIONA coisas:
--   * settings.only_brazil: interruptor "Só Brasil" do admin (começa desligado).
--   * settings.night_code_at: quando o código de emergência da noite foi gerado (vazio = desligado,
--     vale o QR das paredes). Não é segredo: só avisa o telão que o código mudou.
--   * tabela night_code: o código em si. Fica fechada pra chave pública (só o servidor lê),
--     senão qualquer um pegava o código lendo o banco.
--
-- Para desfazer:
--   alter table public.settings drop column if exists only_brazil;
--   alter table public.settings drop column if exists night_code_at;
--   drop table if exists public.night_code;

alter table public.settings add column if not exists only_brazil boolean not null default false;
alter table public.settings add column if not exists night_code_at timestamptz;

create table if not exists public.night_code (
  id smallint primary key default 1 check (id = 1),
  code text not null,
  created_at timestamptz not null default now()
);
alter table public.night_code enable row level security;
revoke all on public.night_code from anon, authenticated;

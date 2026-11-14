-- v11: opção no admin para mostrar ou esconder a faixa "líder da noite" no telão.
-- Só ADICIONA uma coluna com valor padrão (ligada), então nada muda até o admin desligar.
alter table public.settings add column if not exists leader_on_tv boolean not null default true;

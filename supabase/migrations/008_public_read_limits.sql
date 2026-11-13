-- v8: o que a chave pública (a que vai para todo celular) consegue ler fica restrito à noite atual.
-- Antes dava para listar todos os nomes já usados e o histórico inteiro de quem cantou o quê.
-- Só muda permissões de leitura; o servidor (chave secreta) continua vendo tudo.
--
-- Para desfazer (volta a ser como antes):
--   drop policy "public read queue" on public.queue;
--   create policy "public read queue" on public.queue for select to anon, authenticated using (true);
--   drop policy "public read singers" on public.singers;
--   create policy "public read singers" on public.singers for select to anon, authenticated using (true);
--   grant select on public.reactions, public.tv_gifs to anon, authenticated;

-- Fila: o que está esperando ou tocando, e o que foi pedido ou cantado nas últimas 24 horas
-- (o ranking da noite e a nota da figurinha vêm daí).
drop policy if exists "public read queue" on public.queue;
create policy "public read queue" on public.queue for select to anon, authenticated
  using (
    status in ('waiting', 'playing')
    or created_at > now() - interval '24 hours'
    or started_at > now() - interval '24 hours'
  );

-- Pessoas: quem entrou nas últimas 24 horas e quem tem música na fila ou cantou nesse período.
drop policy if exists "public read singers" on public.singers;
create policy "public read singers" on public.singers for select to anon, authenticated
  using (
    created_at > now() - interval '24 hours'
    or exists (
      select 1 from public.queue q
      where q.singer_id = singers.id
        and (q.status in ('waiting', 'playing') or q.started_at > now() - interval '24 hours')
    )
  );

-- Reações e GIFs: o telão só precisa saber o que apareceu, não quem mandou.
revoke select on public.reactions from anon, authenticated;
grant select (id, queue_id, emoji, created_at) on public.reactions to anon, authenticated;
revoke select on public.tv_gifs from anon, authenticated;
grant select (id, name, kind, ref, created_at) on public.tv_gifs to anon, authenticated;

-- v10: a nota do ranking da noite passa a sair dos VOTOS (as 5 carinhas, igual ao campeonato),
-- e não mais da quantidade de reações.
-- Só ADICIONA coisas (uma coluna) e troca duas funções mantendo a mesma assinatura:
--   * votes.contest_id pode ficar vazio: voto do ranking da noite não tem campeonato.
--   * queue.vote_count: quantas pessoas deram nota pra música.
--   * cast_vote: aceita voto quando o campeonato OU o ranking da noite estiver ligado.
--   * score_song: nota = média das carinhas (1 a 5) x 2, de 0 a 10. Sem voto, sem nota.
-- O campeonato continua igual (contest_standings só olha os votos com o id dele).

alter table public.votes alter column contest_id drop not null;

alter table public.queue add column if not exists vote_count int;

-- Cliente dá nota (1 a 5) para quem está cantando agora. Pode trocar até a música acabar.
-- Vale no campeonato e no ranking da noite.
create or replace function public.cast_vote(p_token_hash text, p_score int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_id uuid; v_status text; v_contest bigint; v_ranking boolean; v_queue bigint; v_performer uuid;
begin
  if p_score is null or p_score < 1 or p_score > 5 then return jsonb_build_object('status', 'invalid'); end if;
  select id, status into v_id, v_status from singers where token_hash = p_token_hash;
  if v_id is null then return jsonb_build_object('status', 'unknown'); end if;
  if v_status <> 'approved' then return jsonb_build_object('status', v_status); end if;
  select contest_id, ranking_enabled into v_contest, v_ranking from settings where id = 1;
  if v_contest is null and not coalesce(v_ranking, false) then return jsonb_build_object('status', 'no_contest'); end if;
  select id, singer_id into v_queue, v_performer from queue where status = 'playing' limit 1;
  if v_queue is null then return jsonb_build_object('status', 'idle'); end if;
  if v_performer = v_id then return jsonb_build_object('status', 'self'); end if;
  insert into votes (contest_id, queue_id, voter_id, score) values (v_contest, v_queue, v_id, p_score)
  on conflict (queue_id, voter_id) do update set score = excluded.score, contest_id = excluded.contest_id, created_at = now();
  return jsonb_build_object('status', 'ok', 'queue_id', v_queue, 'score', p_score);
end; $$;
revoke all on function public.cast_vote(text, int) from public, anon, authenticated;
grant execute on function public.cast_vote(text, int) to service_role;

-- Ranking da noite: quando uma música termina, a nota é a média das carinhas (1 a 5) x 2.
-- Quem canta não vota em si mesmo (cast_vote já barra). Sem voto nenhum, a música fica sem nota.
-- Não dá nota durante um campeonato (lá o placar é do campeonato) nem para música pulada no começo.
-- Qualquer erro aqui é ignorado: a fila nunca deixa de andar por causa da nota.
create or replace function public.score_song()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_on boolean; v_contest bigint; v_avg numeric; v_n int;
begin
  begin
    select ranking_enabled, contest_id into v_on, v_contest from settings where id = 1;
    if not coalesce(v_on, false) or v_contest is not null then return new; end if;
    if new.started_at is null then return new; end if;
    if new.status = 'skipped' and now() - new.started_at < interval '60 seconds' then return new; end if;

    select avg(v.score), count(*)::int into v_avg, v_n
    from votes v
    where v.queue_id = new.id and v.voter_id <> new.singer_id;

    new.vote_count := coalesce(v_n, 0);
    if coalesce(v_n, 0) > 0 then
      new.score := least(10, greatest(0, round(v_avg * 2, 1)));
    end if;
  exception when others then
    null;
  end;
  return new;
end; $$;
revoke all on function public.score_song() from public, anon, authenticated;
grant select (vote_count) on public.queue to anon, authenticated;

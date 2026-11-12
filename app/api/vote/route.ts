import { NextRequest } from 'next/server';
import { db, isMissingSchema, NEEDS_MIGRATION } from '@/lib/supabase-server';
import { hashToken, singerFromRequest } from '@/lib/auth';
import { fail, json, readBody } from '@/lib/http';

export const dynamic = 'force-dynamic';

/** Contest mode: a customer scores (1-5) whoever is singing right now. Can be changed until the song ends. */
export async function POST(req: NextRequest) {
  const token = req.headers.get('x-singer-token');
  if (!token || token.length > 100) return fail('Entre com seu nome primeiro', 401);
  const score = Number((await readBody(req)).score);
  if (!Number.isInteger(score) || score < 1 || score > 5) return fail('Nota inválida');
  const { data, error } = await db().rpc('cast_vote', { p_token_hash: hashToken(token), p_score: score });
  if (error) return isMissingSchema(error) ? fail(NEEDS_MIGRATION, 409) : fail('Tente de novo em instantes', 503);
  const res = (data ?? {}) as { status?: string; queue_id?: number; score?: number };
  switch (res.status) {
    case 'ok':
      return json({ ok: true, queueId: res.queue_id, score: res.score });
    case 'self':
      return fail('Você não pode votar em você mesmo.', 403);
    case 'idle':
      return fail('A música acabou. A votação desta apresentação encerrou.', 409);
    case 'no_contest':
      return fail('O campeonato não está valendo agora.', 409);
    case 'pending':
      return fail('Aguarde o admin liberar sua entrada para votar.', 403);
    case 'unknown':
      return fail('Entre com seu nome primeiro', 401);
    default:
      return fail('Você não pode votar.', 403);
  }
}

/** The vote this customer already gave to the song that is playing (so the phone can highlight it). */
export async function GET(req: NextRequest) {
  let singer;
  try {
    singer = await singerFromRequest(req);
  } catch {
    return fail('Tente de novo em instantes', 503);
  }
  if (!singer) return fail('Não encontrado', 401);
  const { data: playing } = await db().from('queue').select('id').eq('status', 'playing').maybeSingle();
  if (!playing) return json({ queueId: null, score: null });
  const { data: vote } = await db()
    .from('votes')
    .select('score')
    .eq('queue_id', playing.id)
    .eq('voter_id', singer.id)
    .maybeSingle();
  return json({ queueId: playing.id, score: vote?.score ?? null });
}

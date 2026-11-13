import { NextRequest } from 'next/server';
import { db, isMissingSchema, NEEDS_MIGRATION } from '@/lib/supabase-server';
import { hashToken } from '@/lib/auth';
import { fail, json, readBody } from '@/lib/http';
import { REACTIONS } from '@/lib/types';

const KEYS: readonly string[] = REACTIONS.map((r) => r.key);

/** A customer sends a reaction to whoever is singing. It shows up floating on the projector. */
export async function POST(req: NextRequest) {
  const token = req.headers.get('x-singer-token');
  if (!token || token.length > 100) return fail('Entre com seu nome primeiro', 401);
  const emoji = String((await readBody(req)).emoji ?? '');
  if (!KEYS.includes(emoji)) return fail('Reação inválida');
  const { data, error } = await db().rpc('send_reaction', { p_token_hash: hashToken(token), p_emoji: emoji });
  if (error) return isMissingSchema(error) ? fail(NEEDS_MIGRATION, 409) : fail('Deu uma travadinha aqui. Tenta de novo em instantes.', 503);
  switch (data) {
    case 'ok':
      return json({ ok: true });
    case 'slow':
      return fail('Calma, coração! Muitas reações seguidas.', 429);
    case 'idle':
      return fail('Ninguém tá cantando agora.', 409);
    case 'off':
      return fail('As reações estão desligadas agora.', 403);
    case 'pending':
      return fail('Só um instante: o admin ainda vai liberar sua entrada.', 403);
    case 'unknown':
      return fail('Entre com seu nome primeiro', 401);
    default:
      return fail('Você não pode reagir.', 403);
  }
}

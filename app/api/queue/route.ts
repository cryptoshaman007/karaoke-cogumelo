import { NextRequest } from 'next/server';
import { db, getSettings } from '@/lib/supabase-server';
import { singerFromRequest } from '@/lib/auth';
import { fail, json, readBody } from '@/lib/http';
import { parseSong } from '@/lib/song';

export async function POST(req: NextRequest) {
  let singer;
  try {
    singer = await singerFromRequest(req);
  } catch {
    return fail('Tente de novo em instantes', 503);
  }
  if (!singer) return fail('Entre com seu nome primeiro', 401);
  if (singer.status === 'blocked') return fail('Você não pode adicionar músicas', 403);
  const settings = await getSettings();
  if (!settings.queue_open) return fail('A fila está fechada por hoje. Obrigado por cantar!', 403);
  const song = parseSong(await readBody(req), settings);
  if (typeof song === 'string') return fail(song);
  const { error } = await db()
    .from('queue')
    .insert({ singer_id: singer.id, ...song, position: Date.now() / 1000 });
  if (error) {
    if (error.code === '23505') return fail('Você já tem uma música na fila. Espere ela tocar!', 409);
    return fail('Não foi possível adicionar', 500);
  }
  return json({ ok: true });
}

/** Customer cancels their own waiting song. */
export async function DELETE(req: NextRequest) {
  let singer;
  try {
    singer = await singerFromRequest(req);
  } catch {
    return fail('Tente de novo em instantes', 503);
  }
  if (!singer) return fail('Não encontrado', 401);
  const { error } = await db().from('queue').update({ status: 'skipped' }).eq('singer_id', singer.id).eq('status', 'waiting');
  if (error) return fail('Não foi possível tirar a música', 500);
  return json({ ok: true });
}

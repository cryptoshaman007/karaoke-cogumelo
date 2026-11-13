import { NextRequest } from 'next/server';
import { db, getSettings } from '@/lib/supabase-server';
import { singerFromRequest } from '@/lib/auth';
import { fail, json, readBody } from '@/lib/http';
import { parseSong } from '@/lib/song';
import { canEmbed, NOT_EMBEDDABLE } from '@/lib/embed';
import { autoResetNight, nightResetDue } from '@/lib/night';

export async function POST(req: NextRequest) {
  let singer;
  try {
    singer = await singerFromRequest(req);
  } catch {
    return fail('Deu uma travadinha aqui. Tenta de novo em instantes.', 503);
  }
  if (!singer) return fail('Entre com seu nome primeiro', 401);
  if (singer.status === 'blocked') return fail('Poxa, você não tá liberado pra cantar hoje.', 403);
  let settings;
  try {
    settings = await getSettings();
  } catch {
    return fail('Deu uma travadinha aqui. Tenta de novo em instantes.', 503);
  }
  // First song after the bar reopened: last night's leftovers go away before this one enters.
  if (nightResetDue(settings) && (await autoResetNight(settings)) === 'reset') {
    try {
      settings = await getSettings();
    } catch {}
  }
  if (!settings.queue_open) return fail('A fila fechou por hoje. Valeu por cantar com a gente!', 403);
  const song = parseSong(await readBody(req), settings);
  if (typeof song === 'string') return fail(song);
  if (!(await canEmbed(song.video_id))) return fail(NOT_EMBEDDABLE, 422);
  const { error } = await db()
    .from('queue')
    .insert({ singer_id: singer.id, ...song, position: Date.now() / 1000 });
  if (error) {
    if (error.code === '23505') return fail('Você já tem uma música na fila. Canta essa primeiro!', 409);
    return fail('Não deu pra adicionar agora. Tenta de novo.', 500);
  }
  return json({ ok: true });
}

/** Customer cancels their own waiting song. */
export async function DELETE(req: NextRequest) {
  let singer;
  try {
    singer = await singerFromRequest(req);
  } catch {
    return fail('Deu uma travadinha aqui. Tenta de novo em instantes.', 503);
  }
  if (!singer) return fail('Não encontrado', 401);
  const { error } = await db().from('queue').update({ status: 'skipped' }).eq('singer_id', singer.id).eq('status', 'waiting');
  if (error) return fail('Não deu pra tirar a música agora. Tenta de novo.', 500);
  return json({ ok: true });
}

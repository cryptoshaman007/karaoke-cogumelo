import { NextRequest } from 'next/server';
import { db, getSettings, isMissingSchema, promoteReserves } from '@/lib/supabase-server';
import { singerFromRequest } from '@/lib/auth';
import { fail, json, readBody } from '@/lib/http';
import { parseSong } from '@/lib/song';
import { canEmbed, NOT_EMBEDDABLE } from '@/lib/embed';

export const dynamic = 'force-dynamic';

async function who(req: NextRequest) {
  try {
    return { singer: await singerFromRequest(req) };
  } catch {
    return { error: fail('Tente de novo em instantes', 503) };
  }
}

/** The songs this customer left in reserve. */
export async function GET(req: NextRequest) {
  const { singer, error } = await who(req);
  if (error) return error;
  if (!singer) return fail('Não encontrado', 401);
  const { data, error: e } = await db()
    .from('reserves')
    .select('id, video_id, title, thumbnail, duration_sec')
    .eq('singer_id', singer.id)
    .order('id');
  // database not updated yet: simply no reserves
  if (e) return isMissingSchema(e) ? json({ reserves: [] }) : fail('Tente de novo em instantes', 503);
  return json({ reserves: data ?? [] });
}

export async function POST(req: NextRequest) {
  const { singer, error: authError } = await who(req);
  if (authError) return authError;
  if (!singer) return fail('Entre com seu nome primeiro', 401);
  if (singer.status === 'blocked') return fail('Você não pode adicionar músicas', 403);
  let settings;
  try {
    settings = await getSettings();
  } catch {
    return fail('Tente de novo em instantes', 503);
  }
  if (!settings.queue_open) return fail('A fila está fechada por hoje. Obrigado por cantar!', 403);
  const song = parseSong(await readBody(req), settings);
  if (typeof song === 'string') return fail(song);
  if (!(await canEmbed(song.video_id))) return fail(NOT_EMBEDDABLE, 422);

  // One trip to the database decides: queue, reserve or "you already have enough".
  const rpc = await db().rpc('enqueue_song', {
    p_singer: singer.id,
    p_video_id: song.video_id,
    p_title: song.title,
    p_thumbnail: song.thumbnail,
    p_duration_sec: song.duration_sec,
  });
  if (!rpc.error) {
    if (rpc.data === 'queued') return json({ ok: true, where: 'queue' });
    if (rpc.data === 'reserved') return json({ ok: true, where: 'reserve' });
    return fail(
      settings.songs_per_person > 1
        ? `Você já tem ${settings.songs_per_person} músicas guardadas. Espere uma delas tocar!`
        : 'Você já tem uma música na fila. Espere ela tocar!',
      409,
    );
  }
  if (rpc.error.code === '23505') return fail('Você já tem uma música na fila. Espere ela tocar!', 409);
  if (!isMissingSchema(rpc.error)) return fail('Não foi possível adicionar', 500);

  // Database not updated yet: the old way, one song per person.
  const { error } = await db()
    .from('queue')
    .insert({ singer_id: singer.id, ...song, position: Date.now() / 1000 });
  if (error) {
    if (error.code === '23505') return fail('Você já tem uma música na fila. Espere ela tocar!', 409);
    return fail('Não foi possível adicionar', 500);
  }
  return json({ ok: true, where: 'queue' });
}

/**
 * Customer cancels their own waiting song (then a reserve, if any, takes its turn at the end of
 * the queue), or with ?reserve=ID gives up one reserve song.
 */
export async function DELETE(req: NextRequest) {
  const { singer, error: authError } = await who(req);
  if (authError) return authError;
  if (!singer) return fail('Não encontrado', 401);
  const reserve = req.nextUrl.searchParams.get('reserve');
  if (reserve != null) {
    const id = Number(reserve);
    if (!Number.isInteger(id)) return fail('Música inválida');
    const { error } = await db().from('reserves').delete().eq('id', id).eq('singer_id', singer.id);
    if (error) return fail('Não foi possível tirar a música', 500);
    return json({ ok: true });
  }
  const { error } = await db().from('queue').update({ status: 'skipped' }).eq('singer_id', singer.id).eq('status', 'waiting');
  if (error) return fail('Não foi possível tirar a música', 500);
  await promoteReserves();
  return json({ ok: true });
}

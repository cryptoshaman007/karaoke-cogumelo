import { NextRequest } from 'next/server';
import { guardPublic } from '@/lib/guard';
import { db, getSettings, isMissingSchema, promoteReserves } from '@/lib/supabase-server';
import { singerFromRequest } from '@/lib/auth';
import { fail, json, readBody } from '@/lib/http';
import { parseSong } from '@/lib/song';
import { canEmbed, NOT_EMBEDDABLE } from '@/lib/embed';
import { autoResetNight, nightResetDue } from '@/lib/night';
import { songSigOk } from '@/lib/songsig';

const BAD_SIG = 'Essa música veio de um jeito estranho. Busca ela de novo, por favor!';

/** The song must be one this server handed out (search, link, "mais cantadas"), title and length unchanged. */
function signed(body: Record<string, unknown>) {
  return songSigOk(String(body.videoId ?? ''), String(body.title ?? ''), Number(body.durationSec), body.sig);
}

export const dynamic = 'force-dynamic';

async function who(req: NextRequest) {
  try {
    return { singer: await singerFromRequest(req) };
  } catch {
    return { error: fail('Deu uma travadinha aqui. Tenta de novo em instantes.', 503) };
  }
}

/** The songs this customer left in reserve. */
export async function GET(req: NextRequest) {
  const gated = await guardPublic(req);
  if (gated) return gated;
  const { singer, error } = await who(req);
  if (error) return error;
  if (!singer) return fail('Não encontrado', 401);
  const { data, error: e } = await db()
    .from('reserves')
    .select('id, video_id, title, thumbnail, duration_sec')
    .eq('singer_id', singer.id)
    .order('id');
  // database not updated yet: simply no reserves
  if (e) return isMissingSchema(e) ? json({ reserves: [] }) : fail('Deu uma travadinha aqui. Tenta de novo em instantes.', 503);
  return json({ reserves: data ?? [] });
}

export async function POST(req: NextRequest) {
  const gated = await guardPublic(req);
  if (gated) return gated;
  const { singer, error: authError } = await who(req);
  if (authError) return authError;
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
  const body = await readBody(req);
  const song = parseSong(body, settings);
  if (typeof song === 'string') return fail(song);
  if (!signed(body)) return fail(BAD_SIG, 422);
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
        ? `Você já tem ${settings.songs_per_person} músicas guardadas. Canta uma delas primeiro!`
        : 'Você já tem uma música na fila. Canta essa primeiro!',
      409,
    );
  }
  if (rpc.error.code === '23505') return fail('Você já tem uma música na fila. Canta essa primeiro!', 409);
  if (!isMissingSchema(rpc.error)) return fail('Não deu pra adicionar agora. Tenta de novo.', 500);

  // Database not updated yet: the old way, one song per person.
  const { error } = await db()
    .from('queue')
    .insert({ singer_id: singer.id, ...song, position: Date.now() / 1000 });
  if (error) {
    if (error.code === '23505') return fail('Você já tem uma música na fila. Canta essa primeiro!', 409);
    return fail('Não deu pra adicionar agora. Tenta de novo.', 500);
  }
  return json({ ok: true, where: 'queue' });
}

/**
 * "Trocar a música": the customer swaps the song waiting in the queue for another one and keeps
 * the place in line.
 */
export async function PUT(req: NextRequest) {
  const gated = await guardPublic(req);
  if (gated) return gated;
  const { singer, error: authError } = await who(req);
  if (authError) return authError;
  if (!singer) return fail('Entre com seu nome primeiro', 401);
  if (singer.status === 'blocked') return fail('Poxa, você não tá liberado pra cantar hoje.', 403);
  let settings;
  try {
    settings = await getSettings();
  } catch {
    return fail('Deu uma travadinha aqui. Tenta de novo em instantes.', 503);
  }
  if (!settings.queue_open) return fail('A fila fechou por hoje. Valeu por cantar com a gente!', 403);
  const body = await readBody(req);
  const song = parseSong(body, settings);
  if (typeof song === 'string') return fail(song);
  if (!signed(body)) return fail(BAD_SIG, 422);
  if (!(await canEmbed(song.video_id))) return fail(NOT_EMBEDDABLE, 422);
  const { data, error } = await db()
    .from('queue')
    .update(song)
    .eq('singer_id', singer.id)
    .eq('status', 'waiting')
    .select('id');
  if (error) return fail('Não deu pra trocar agora. Tenta de novo.', 500);
  if (!data?.length) return fail('Sua música já começou ou saiu da fila. Escolhe outra lá embaixo!', 409);
  return json({ ok: true });
}

/**
 * Customer cancels their own waiting song (then a reserve, if any, takes its turn at the end of
 * the queue), or with ?reserve=ID gives up one reserve song.
 */
export async function DELETE(req: NextRequest) {
  const gated = await guardPublic(req);
  if (gated) return gated;
  const { singer, error: authError } = await who(req);
  if (authError) return authError;
  if (!singer) return fail('Não encontrado', 401);
  const reserve = req.nextUrl.searchParams.get('reserve');
  if (reserve != null) {
    const id = Number(reserve);
    if (!Number.isInteger(id)) return fail('Música inválida');
    const { error } = await db().from('reserves').delete().eq('id', id).eq('singer_id', singer.id);
    if (error) return fail('Não deu pra tirar a música agora. Tenta de novo.', 500);
    return json({ ok: true });
  }
  const { error } = await db().from('queue').update({ status: 'skipped' }).eq('singer_id', singer.id).eq('status', 'waiting');
  if (error) return fail('Não deu pra tirar a música agora. Tenta de novo.', 500);
  await promoteReserves();
  return json({ ok: true });
}

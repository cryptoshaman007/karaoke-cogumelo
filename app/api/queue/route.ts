import { NextRequest } from 'next/server';
import { db, getSettings } from '@/lib/supabase-server';
import { singerFromRequest } from '@/lib/auth';
import { fail, json } from '@/lib/http';

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{6,20}$/;

export async function POST(req: NextRequest) {
  const singer = await singerFromRequest(req);
  if (!singer) return fail('Entre com seu nome primeiro', 401);
  if (singer.status === 'blocked') return fail('Você não pode adicionar músicas', 403);
  const body = await req.json().catch(() => ({}));
  const videoId = String(body.videoId ?? '');
  const title = String(body.title ?? '').slice(0, 200);
  const thumbnail = String(body.thumbnail ?? '').slice(0, 300) || null;
  const durationSec = Math.round(Number(body.durationSec));
  if (!VIDEO_ID_RE.test(videoId) || !title || !Number.isFinite(durationSec) || durationSec <= 0) {
    return fail('Música inválida');
  }
  const settings = await getSettings();
  if (durationSec > settings.max_duration_sec) {
    return fail(`Músicas de até ${Math.floor(settings.max_duration_sec / 60)} minutos`);
  }
  const { error } = await db().from('queue').insert({
    singer_id: singer.id,
    video_id: videoId,
    title,
    thumbnail,
    duration_sec: durationSec,
    position: Date.now() / 1000,
  });
  if (error) {
    if (error.code === '23505') return fail('Você já tem uma música na fila. Espere ela tocar!', 409);
    return fail('Não foi possível adicionar', 500);
  }
  return json({ ok: true });
}

/** Customer cancels their own waiting song. */
export async function DELETE(req: NextRequest) {
  const singer = await singerFromRequest(req);
  if (!singer) return fail('Não encontrado', 401);
  await db().from('queue').update({ status: 'skipped' }).eq('singer_id', singer.id).eq('status', 'waiting');
  return json({ ok: true });
}

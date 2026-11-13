import { NextRequest } from 'next/server';
import { db } from '@/lib/supabase-server';
import { isAdmin } from '@/lib/auth';
import { fail, json, readBody } from '@/lib/http';

export async function POST(req: NextRequest) {
  if (!(await isAdmin())) return fail('Faça login no admin', 401);
  const body = await readBody(req);
  const patch: Record<string, unknown> = {};

  if (body.maxDurationMin != null) {
    const min = Number(body.maxDurationMin);
    if (!Number.isFinite(min) || min < 1 || min > 30) return fail('Limite entre 1 e 30 minutos');
    patch.max_duration_sec = Math.round(min * 60);
  }
  if (body.requireApproval != null) patch.require_approval = Boolean(body.requireApproval);
  if (body.queueOpen != null) patch.queue_open = Boolean(body.queueOpen);
  if (body.intermissionSec != null) {
    const sec = Math.round(Number(body.intermissionSec));
    if (!Number.isFinite(sec) || sec < 0 || sec > 30) return fail('Intervalo entre 0 e 30 segundos');
    patch.intermission_sec = sec;
  }
  if (body.tvMessage != null) {
    patch.tv_message = String(body.tvMessage).replace(/\s+/g, ' ').trim().slice(0, 140);
  }
  if (body.reactionsEnabled != null) patch.reactions_enabled = Boolean(body.reactionsEnabled);
  if (body.rankingEnabled != null) {
    patch.ranking_enabled = Boolean(body.rankingEnabled);
    if (!patch.ranking_enabled) patch.ranking_on_tv = false;
  }
  if (body.rankingOnTv != null) patch.ranking_on_tv = Boolean(body.rankingOnTv);
  if (body.gifsEnabled != null) patch.gifs_enabled = Boolean(body.gifsEnabled);
  if (body.photosEnabled != null) patch.photos_enabled = Boolean(body.photosEnabled);
  if (body.nightResetHour !== undefined) {
    // null or a negative number turns the automatic clean-up off
    const h = body.nightResetHour === null ? -1 : Math.round(Number(body.nightResetHour));
    if (!Number.isFinite(h) || h > 23) return fail('Hora entre 0 e 23');
    patch.night_reset_hour = h < 0 ? null : h;
  }
  if (body.tvAddEnabled != null) patch.tv_add_enabled = Boolean(body.tvAddEnabled);
  if (body.songsPerPerson != null) {
    const n = Math.round(Number(body.songsPerPerson));
    if (!Number.isFinite(n) || n < 1 || n > 3) return fail('Entre 1 e 3 músicas por pessoa');
    patch.songs_per_person = n;
  }
  if (body.paused != null) patch.paused = Boolean(body.paused);
  if (body.volume != null) {
    const v = Math.round(Number(body.volume));
    if (!Number.isFinite(v) || v < 0 || v > 100) return fail('Volume entre 0 e 100');
    patch.volume = v;
  }
  if (body.restart === true) {
    patch.restart_at = new Date().toISOString();
    patch.paused = false;
  }
  if (Object.keys(patch).length === 0) return fail('Nada para salvar');

  patch.updated_at = new Date().toISOString();
  const { error } = await db().from('settings').update(patch).eq('id', 1);
  if (error) {
    // 42703 / PGRST204: the database is still missing the newer columns
    if (error.code === '42703' || error.code === 'PGRST204') {
      return fail('Essa função ainda precisa da atualização do banco de dados (migrações em supabase/migrations).', 409);
    }
    return fail(error.message, 500);
  }
  return json({ ok: true });
}

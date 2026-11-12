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
      return fail('Esta função precisa da atualização do banco de dados (migração v2).', 409);
    }
    return fail(error.message, 500);
  }
  return json({ ok: true });
}

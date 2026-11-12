import { NextRequest } from 'next/server';
import { db } from '@/lib/supabase-server';
import { isAdmin } from '@/lib/auth';
import { fail, json } from '@/lib/http';

export async function POST(req: NextRequest) {
  if (!(await isAdmin())) return fail('Faça login no admin', 401);
  const body = await req.json().catch(() => ({}));
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (body.maxDurationMin != null) {
    const min = Number(body.maxDurationMin);
    if (!Number.isFinite(min) || min < 1 || min > 30) return fail('Limite entre 1 e 30 minutos');
    patch.max_duration_sec = Math.round(min * 60);
  }
  if (body.requireApproval != null) patch.require_approval = Boolean(body.requireApproval);
  const { error } = await db().from('settings').update(patch).eq('id', 1);
  if (error) return fail(error.message, 500);
  return json({ ok: true });
}

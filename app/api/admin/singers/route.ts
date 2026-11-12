import { NextRequest } from 'next/server';
import { db } from '@/lib/supabase-server';
import { isAdmin } from '@/lib/auth';
import { fail, json } from '@/lib/http';

export async function POST(req: NextRequest) {
  if (!(await isAdmin())) return fail('Faça login no admin', 401);
  const body = await req.json().catch(() => ({}));
  const id = String(body.id ?? '');
  const status = String(body.status ?? '');
  if (!['pending', 'approved', 'blocked'].includes(status)) return fail('Status inválido');
  const { error } = await db().from('singers').update({ status }).eq('id', id);
  if (error) return fail(error.message, 500);
  if (status === 'blocked') {
    await db().from('queue').update({ status: 'skipped' }).eq('singer_id', id).eq('status', 'waiting');
  }
  return json({ ok: true });
}

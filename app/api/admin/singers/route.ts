import { NextRequest } from 'next/server';
import { db } from '@/lib/supabase-server';
import { isAdmin } from '@/lib/auth';
import { fail, json, readBody } from '@/lib/http';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest) {
  if (!(await isAdmin())) return fail('Faça login no admin', 401);
  const body = await readBody(req);
  const id = String(body.id ?? '');
  const status = String(body.status ?? '');
  if (!UUID_RE.test(id)) return fail('Pessoa inválida');
  if (!['pending', 'approved', 'blocked'].includes(status)) return fail('Status inválido');
  const { error } = await db().from('singers').update({ status }).eq('id', id);
  if (error) return fail(error.message, 500);
  if (status === 'blocked') {
    await db().from('queue').update({ status: 'skipped' }).eq('singer_id', id).eq('status', 'waiting');
  }
  return json({ ok: true });
}

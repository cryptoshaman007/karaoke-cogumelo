import { NextRequest } from 'next/server';
import { db } from '@/lib/supabase-server';
import { requireAdmin } from '@/lib/auth';
import { fail, json, readBody } from '@/lib/http';
import { removePhoto } from '@/lib/photos';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PENDING_WINDOW_MS = 12 * 3600 * 1000; // same window the admin panel lists

export async function POST(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const body = await readBody(req);

  // "Recusar todos": a flood of fake names leaves the approval list in one tap
  if (body.action === 'refuseAllPending') {
    const since = new Date(Date.now() - PENDING_WINDOW_MS).toISOString();
    const { data, error } = await db()
      .from('singers')
      .update({ status: 'blocked' })
      .eq('status', 'pending')
      .gte('created_at', since)
      .select('id');
    if (error) return fail(error.message, 500);
    const ids = (data ?? []).map((r: { id: string }) => r.id);
    for (let i = 0; i < ids.length; i += 100) {
      const part = ids.slice(i, i + 100);
      await db().from('reserves').delete().in('singer_id', part);
      await db().from('queue').update({ status: 'skipped' }).in('singer_id', part).eq('status', 'waiting');
    }
    return json({ ok: true, refused: ids.length });
  }

  const id = String(body.id ?? '');
  const status = String(body.status ?? '');
  if (!UUID_RE.test(id)) return fail('Pessoa inválida');
  // the admin takes an improper selfie off the projector
  if (body.removePhoto === true) {
    if (!(await removePhoto(id))) return fail('Não deu pra apagar a foto agora. Tenta de novo.', 500);
    return json({ ok: true });
  }
  if (!['pending', 'approved', 'blocked'].includes(status)) return fail('Status inválido');
  const { error } = await db().from('singers').update({ status }).eq('id', id);
  if (error) return fail(error.message, 500);
  if (status === 'blocked') {
    await removePhoto(id);
    await db().from('reserves').delete().eq('singer_id', id);
    await db().from('queue').update({ status: 'skipped' }).eq('singer_id', id).eq('status', 'waiting');
  }
  return json({ ok: true });
}

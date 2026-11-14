import { NextRequest } from 'next/server';
import { db } from '@/lib/supabase-server';
import { requireAdmin } from '@/lib/auth';
import { fail, json, readBody } from '@/lib/http';
import { removePhoto } from '@/lib/photos';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PENDING_WINDOW_MS = 12 * 3600 * 1000; // same window the admin panel lists

/**
 * Everyone refused, newest first. The panel's live data only lists people from the last 24 hours
 * (public read, migration 008), so someone refused on an earlier night would vanish from the list
 * and could never be released. This reads with the secret key.
 */
export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;
  const { data, error } = await db()
    .from('singers')
    .select('id, name, status, created_at')
    .eq('status', 'blocked')
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) return fail('Deu uma travadinha aqui. Tenta de novo em instantes.', 503);
  return json({ singers: data ?? [] });
}

export async function POST(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const body = await readBody(req);

  // "Recusar todos": a flood of fake names leaves the approval list in one tap
  // Only the people the admin saw on the list (`ids`): someone real who arrived a second before the
  // tap is not refused along with the fake names.
  if (body.action === 'refuseAllPending') {
    const since = new Date(Date.now() - PENDING_WINDOW_MS).toISOString();
    const shown = Array.isArray(body.ids) ? body.ids.map(String).filter((x: string) => UUID_RE.test(x)).slice(0, 500) : null;
    let q = db().from('singers').update({ status: 'blocked' }).eq('status', 'pending').gte('created_at', since);
    if (shown) {
      if (!shown.length) return json({ ok: true, refused: 0 });
      q = q.in('id', shown);
    }
    const { data, error } = await q.select('id');
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

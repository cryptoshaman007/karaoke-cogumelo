import { NextRequest } from 'next/server';
import { db } from '@/lib/supabase-server';
import { isAdmin } from '@/lib/auth';
import { fail, json } from '@/lib/http';

export async function POST(req: NextRequest) {
  if (!(await isAdmin())) return fail('Faça login no admin', 401);
  const body = await req.json().catch(() => ({}));
  const action = String(body.action ?? '');
  const id = Number(body.id);
  const sb = db();

  if (action === 'skip') {
    const { data, error } = await sb.rpc('advance_queue', { p_current: Number.isFinite(id) ? id : null, p_end_status: 'skipped' });
    if (error) return fail(error.message, 500);
    return json({ playing: data });
  }
  if (action === 'remove') {
    await sb.from('queue').update({ status: 'skipped' }).eq('id', id).eq('status', 'waiting');
    return json({ ok: true });
  }
  if (action === 'clear') {
    await sb.from('queue').update({ status: 'skipped' }).eq('status', 'waiting');
    return json({ ok: true });
  }
  if (action === 'up' || action === 'down') {
    const { data: rows } = await sb
      .from('queue')
      .select('id, position')
      .eq('status', 'waiting')
      .order('position')
      .order('id');
    if (!rows) return fail('Erro', 500);
    const i = rows.findIndex((r) => r.id === id);
    const j = action === 'up' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= rows.length) return json({ ok: true });
    const a = rows[i];
    const b = rows[j];
    // give distinct positions even if equal
    const pa = b.position === a.position ? b.position + (action === 'up' ? -0.001 : 0.001) : b.position;
    await sb.from('queue').update({ position: pa }).eq('id', a.id);
    await sb.from('queue').update({ position: a.position }).eq('id', b.id);
    return json({ ok: true });
  }
  return fail('Ação inválida');
}

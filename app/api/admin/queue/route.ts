import { NextRequest } from 'next/server';
import { advanceQueue, db, getSettings } from '@/lib/supabase-server';
import { hashToken, isAdmin, newSingerToken } from '@/lib/auth';
import { fail, json, readBody } from '@/lib/http';
import { cleanName, parseSong } from '@/lib/song';
import { canEmbed, NOT_EMBEDDABLE } from '@/lib/embed';

export async function POST(req: NextRequest) {
  if (!(await isAdmin())) return fail('Faça login no admin', 401);
  const body = await readBody(req);
  const action = String(body.action ?? '');
  const id = Number(body.id);
  const sb = db();

  if (action === 'skip') {
    try {
      return json({ playing: await advanceQueue(Number.isFinite(id) ? id : null, 'skipped') });
    } catch (e) {
      return fail((e as Error).message, 500);
    }
  }

  if (action === 'remove') {
    if (!Number.isFinite(id)) return fail('Música inválida');
    const { error } = await sb.from('queue').update({ status: 'skipped' }).eq('id', id).eq('status', 'waiting');
    if (error) return fail(error.message, 500);
    return json({ ok: true });
  }

  if (action === 'clear') {
    const { error } = await sb.from('queue').update({ status: 'skipped' }).eq('status', 'waiting');
    if (error) return fail(error.message, 500);
    return json({ ok: true });
  }

  if (action === 'up' || action === 'down' || action === 'top') {
    const { data: rows, error } = await sb
      .from('queue')
      .select('id, position')
      .eq('status', 'waiting')
      .order('position')
      .order('id');
    if (error || !rows) return fail('Não foi possível reordenar', 500);
    const i = rows.findIndex((r) => r.id === id);
    if (i < 0) return json({ ok: true });

    if (action === 'top') {
      if (i === 0) return json({ ok: true });
      const { error: e } = await sb.from('queue').update({ position: rows[0].position - 1 }).eq('id', id).eq('status', 'waiting');
      if (e) return fail(e.message, 500);
      return json({ ok: true });
    }

    const j = action === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= rows.length) return json({ ok: true });
    const a = rows[i];
    const b = rows[j];
    // Place `a` strictly on the other side of `b` (midpoint with b's other neighbour), so a single
    // write is enough and the order never ends up half-swapped.
    const beyond = rows[action === 'up' ? j - 1 : j + 1];
    const target = beyond ? (b.position + beyond.position) / 2 : b.position + (action === 'up' ? -1 : 1);
    if (beyond && (target === b.position || target === beyond.position)) {
      // positions too close to split (same value): fall back to a plain swap
      const pa = b.position === a.position ? b.position + (action === 'up' ? -0.001 : 0.001) : b.position;
      await sb.from('queue').update({ position: pa }).eq('id', a.id);
      await sb.from('queue').update({ position: a.position }).eq('id', b.id);
      return json({ ok: true });
    }
    const { error: e } = await sb.from('queue').update({ position: target }).eq('id', a.id).eq('status', 'waiting');
    if (e) return fail(e.message, 500);
    return json({ ok: true });
  }

  // Admin puts a song in the queue for someone who has no phone at hand.
  if (action === 'add') {
    const name = cleanName(body.name);
    if (!name) return fail('Digite o nome da pessoa');
    let settings;
    try {
      settings = await getSettings();
    } catch {
      return fail('Tente de novo em instantes', 503);
    }
    const song = parseSong((body.song ?? {}) as Record<string, unknown>, settings);
    if (typeof song === 'string') return fail(song);
    if (!(await canEmbed(song.video_id))) return fail(NOT_EMBEDDABLE, 422);
    const { data: singer, error: e1 } = await sb
      .from('singers')
      .insert({ name, token_hash: hashToken(newSingerToken()), status: 'approved' })
      .select('id')
      .single();
    if (e1 || !singer) return fail('Não foi possível adicionar', 500);
    const { error: e2 } = await sb.from('queue').insert({ singer_id: singer.id, ...song, position: Date.now() / 1000 });
    if (e2) {
      await sb.from('singers').delete().eq('id', singer.id);
      return fail('Não foi possível adicionar', 500);
    }
    return json({ ok: true });
  }

  return fail('Ação inválida');
}

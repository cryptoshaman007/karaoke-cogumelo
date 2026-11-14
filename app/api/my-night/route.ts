import { NextRequest } from 'next/server';
import { guardPublic } from '@/lib/guard';
import { db, getSettings } from '@/lib/supabase-server';
import { singerFromRequest } from '@/lib/auth';
import { fail, json } from '@/lib/http';
import type { NightSong } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * The songs this customer sang tonight (since the last "zerar a noite"), best first: by the crowd's
 * grade, then by how many reactions came from other people. Feeds the "figurinha da noite".
 */
export async function GET(req: NextRequest) {
  const gated = await guardPublic(req);
  if (gated) return gated;
  let singer;
  try {
    singer = await singerFromRequest(req);
  } catch {
    return fail('Deu uma travadinha aqui. Tenta de novo em instantes.', 503);
  }
  if (!singer) return fail('Entre com seu nome primeiro', 401);
  try {
    const settings = await getSettings();
    // tonight only; a night longer than 18 h is a forgotten reset, so it also stops there
    const since = Math.max(Date.parse(settings.night_started_at ?? '') || 0, Date.now() - 18 * 3600 * 1000);
    const { data: rows, error } = await db()
      .from('queue')
      .select('id, title, score, vote_count, started_at')
      .eq('singer_id', singer.id)
      .in('status', ['done', 'skipped'])
      .not('started_at', 'is', null)
      .gte('started_at', new Date(since).toISOString())
      .order('id', { ascending: false })
      .limit(30);
    if (error) throw error;
    const list = rows ?? [];
    const counts = new Map<number, number>();
    if (list.length > 0) {
      const { data: reacts } = await db()
        .from('reactions')
        .select('queue_id, singer_id')
        .in(
          'queue_id',
          list.map((r) => r.id),
        )
        .limit(5000);
      for (const r of reacts ?? []) {
        if (r.singer_id === singer.id) continue; // reacting to yourself does not count
        counts.set(r.queue_id, (counts.get(r.queue_id) ?? 0) + 1);
      }
    }
    const songs: NightSong[] = list.map((r) => {
      const score = r.score == null || !Number.isFinite(Number(r.score)) ? null : Number(r.score);
      return { id: r.id, title: r.title, score, votes: r.vote_count ?? 0, reactions: counts.get(r.id) ?? 0 };
    });
    songs.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.reactions - a.reactions || b.id - a.id);
    return json({ songs, total: songs.length });
  } catch (e) {
    console.error('my-night failed', e);
    return fail('Deu uma travadinha aqui. Tenta de novo em instantes.', 503);
  }
}

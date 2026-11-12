import { NextRequest } from 'next/server';
import { db, getSettings } from '@/lib/supabase-server';
import { singerFromRequest } from '@/lib/auth';
import { fail, json } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const singer = await singerFromRequest(req);
  if (!singer) return fail('Não encontrado', 404);
  const [{ data: entry }, settings, { data: line }] = await Promise.all([
    db()
      .from('queue')
      .select('id, video_id, title, thumbnail, duration_sec, status, position')
      .eq('singer_id', singer.id)
      .in('status', ['waiting', 'playing'])
      .maybeSingle(),
    getSettings(),
    db()
      .from('queue')
      .select('id, singer_id, position, status, singers!inner(status)')
      .eq('status', 'waiting')
      .eq('singers.status', 'approved')
      .order('position')
      .order('id'),
  ]);
  let ahead: number | null = null;
  if (entry && entry.status === 'waiting' && line) {
    const idx = line.findIndex((r) => r.id === entry.id);
    ahead = idx >= 0 ? idx : null;
  }
  return json({ singer, entry, ahead, maxDurationSec: settings.max_duration_sec });
}

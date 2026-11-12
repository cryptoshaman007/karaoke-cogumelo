import { db } from '@/lib/supabase-server';
import type { PopularSong } from '@/lib/types';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/** Songs most sung at the bar, from the queue history. Cached at the CDN for 5 minutes. */
export async function GET() {
  let songs: PopularSong[] = [];
  try {
    const { data } = await db()
      .from('queue')
      .select('video_id, title, duration_sec')
      .eq('status', 'done')
      .order('id', { ascending: false })
      .limit(800);
    const byId = new Map<string, PopularSong>();
    for (const r of data ?? []) {
      const hit = byId.get(r.video_id);
      if (hit) hit.count++;
      else
        byId.set(r.video_id, {
          videoId: r.video_id,
          title: r.title,
          thumbnail: `https://i.ytimg.com/vi/${r.video_id}/mqdefault.jpg`,
          durationSec: r.duration_sec,
          channel: '',
          count: 1,
        });
    }
    songs = [...byId.values()].sort((a, b) => b.count - a.count).slice(0, 12);
  } catch (e) {
    console.error('popular failed', e);
  }
  return NextResponse.json(
    { songs },
    { headers: { 'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=900' } },
  );
}

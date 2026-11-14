import 'server-only';
import type { SearchResult } from './types';
import { db } from './supabase-server';
import { timeoutSignal } from './timeout';
import { KARAOKE_RE, NOT_KARAOKE_RE } from './song';

// Plan B for the search, for when YouTube does not answer our server or answers in a way the
// unofficial reader (lib/youtube.ts) no longer understands. The customer still finds songs:
//   1. with YOUTUBE_API_KEY set on Vercel: the official YouTube search (free, about 100 searches a day);
//   2. always: the songs already sung at the bar (queue history), so the night never stops.

const CACHE_MS = 30 * 60 * 1000;
const cache = new Map<string, { at: number; results: SearchResult[] }>();

/** "Evidências" and "evidencias" are the same word here. */
const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

const words = (s: string) =>
  fold(s)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2 && !['karaoke', 'karaok', 'videoke', 'versao', 'de', 'da', 'do', 'e', 'a', 'o'].includes(w));

/** ISO 8601 duration (PT4M13S) in seconds. */
function isoSeconds(d: string): number {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d ?? '');
  if (!m) return 0;
  return +(m[1] ?? 0) * 86400 + +(m[2] ?? 0) * 3600 + +(m[3] ?? 0) * 60 + +(m[4] ?? 0);
}

/** Official YouTube Data API search. Null when there is no key or it could not answer. */
async function officialSearch(term: string): Promise<SearchResult[] | null> {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return null;
  try {
    const base = 'https://www.googleapis.com/youtube/v3';
    const q = new URLSearchParams({ part: 'id', type: 'video', maxResults: '25', q: term, regionCode: 'BR', relevanceLanguage: 'pt', key });
    const s = await fetch(`${base}/search?${q}`, { signal: timeoutSignal(5000), cache: 'no-store' });
    if (!s.ok) return null;
    const ids: string[] = ((await s.json())?.items ?? []).map((i: { id?: { videoId?: string } }) => i?.id?.videoId).filter(Boolean);
    if (!ids.length) return [];
    const v = new URLSearchParams({ part: 'snippet,contentDetails', id: ids.join(','), key });
    const r = await fetch(`${base}/videos?${v}`, { signal: timeoutSignal(5000), cache: 'no-store' });
    if (!r.ok) return null;
    const out: SearchResult[] = [];
    for (const it of (await r.json())?.items ?? []) {
      const title = String(it?.snippet?.title ?? '');
      const durationSec = isoSeconds(it?.contentDetails?.duration ?? '');
      const live = it?.snippet?.liveBroadcastContent && it.snippet.liveBroadcastContent !== 'none';
      if (!it?.id || live || !durationSec || !KARAOKE_RE.test(title) || NOT_KARAOKE_RE.test(title)) continue;
      out.push({
        videoId: it.id,
        title,
        thumbnail: `https://i.ytimg.com/vi/${it.id}/mqdefault.jpg`,
        durationSec,
        channel: String(it?.snippet?.channelTitle ?? ''),
      });
    }
    return out;
  } catch {
    return null;
  }
}

/** Songs already sung (or picked) at the bar whose title has every word of the search. */
async function historySearch(query: string): Promise<SearchResult[]> {
  const want = words(query);
  if (!want.length) return [];
  try {
    const { data, error } = await db()
      .from('queue')
      .select('video_id, title, duration_sec, status')
      .order('id', { ascending: false })
      .limit(3000);
    if (error || !data) return [];
    const byId = new Map<string, SearchResult & { n: number }>();
    for (const r of data as { video_id: string; title: string; duration_sec: number; status: string }[]) {
      if (!r.duration_sec || !r.title) continue;
      const hit = byId.get(r.video_id);
      if (hit) {
        hit.n += r.status === 'done' ? 2 : 1;
        continue;
      }
      const have = fold(r.title);
      if (!want.every((w) => have.includes(w))) continue;
      byId.set(r.video_id, {
        videoId: r.video_id,
        title: r.title,
        thumbnail: `https://i.ytimg.com/vi/${r.video_id}/mqdefault.jpg`,
        durationSec: r.duration_sec,
        channel: '',
        n: r.status === 'done' ? 2 : 1,
      });
    }
    return [...byId.values()]
      .sort((a, b) => b.n - a.n)
      .slice(0, 20)
      .map(({ n: _n, ...song }) => song);
  } catch {
    return [];
  }
}

/** Plan B. `source` says where the songs came from (the phone shows a note for 'history'). */
export async function fallbackSearch(query: string, maxDurationSec: number, official = true): Promise<{ results: SearchResult[]; source: 'official' | 'history' }> {
  const q = query.trim().toLowerCase();
  const term = KARAOKE_RE.test(q) ? q : `${q} karaoke`;
  const hit = cache.get(q);
  let results: SearchResult[] | null = hit && Date.now() - hit.at < CACHE_MS ? hit.results : null;
  if (!results && official) {
    results = await officialSearch(term);
    if (results?.length) {
      cache.set(q, { at: Date.now(), results });
      if (cache.size > 300) cache.delete(cache.keys().next().value!);
    }
  }
  if (results?.length) return { results: results.filter((r) => r.durationSec <= maxDurationSec), source: 'official' };
  return { results: (await historySearch(q)).filter((r) => r.durationSec <= maxDurationSec), source: 'history' };
}

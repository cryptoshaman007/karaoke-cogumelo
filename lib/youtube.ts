import 'server-only';
import type { SearchResult } from './types';
import { withTimeout } from './timeout';

// Busca sem chave de API usando a mesma interface interna do site do YouTube (youtubei.js).
// Não é oficial: se parar de funcionar, troque esta função pela YouTube Data API.

type Yt = Awaited<ReturnType<typeof import('youtubei.js').Innertube.create>>;
let ytPromise: Promise<Yt> | null = null;

async function yt(): Promise<Yt> {
  if (!ytPromise) {
    ytPromise = import('youtubei.js').then(({ Innertube }) =>
      Innertube.create({ lang: 'pt', location: 'BR', retrieve_player: false }),
    );
    ytPromise.catch(() => {
      ytPromise = null;
    });
  }
  return ytPromise;
}

const KARAOKE_RE = /karaok[eê]|videok[eê]|sing ?along|vers[aã]o karaok/i;

const cache = new Map<string, { at: number; results: SearchResult[] }>();
const CACHE_MS = 30 * 60 * 1000;

async function searchOnce(term: string) {
  // A slow start is not thrown away: if it times out here, the next try picks up the same session.
  const client = await withTimeout(yt(), 8000);
  try {
    return await withTimeout(client.search(term, { type: 'video' }), 7000);
  } catch (e) {
    // the session may have gone stale: start a fresh one on the next try
    ytPromise = null;
    throw e;
  }
}

export async function searchKaraoke(query: string, maxDurationSec: number): Promise<SearchResult[]> {
  const q = query.trim().toLowerCase();
  const key = q;
  let results: SearchResult[];
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    results = hit.results;
  } else {
    const term = KARAOKE_RE.test(q) ? q : `${q} karaoke`;
    let res;
    const startedAt = Date.now();
    try {
      res = await searchOnce(term);
    } catch (first) {
      console.error('search failed', first);
      try {
        // one more try with a new session, unless the person has already waited too long
        if (Date.now() - startedAt > 9000) throw first;
        res = await searchOnce(term);
      } catch (e) {
        // YouTube is not answering: an old answer for the same search is better than an error
        if (hit) return hit.results.filter((r) => r.durationSec <= maxDurationSec);
        throw e;
      }
    }
    const seen = new Set<string>();
    results = [];
    for (const v of res.videos) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const video = v as any;
      if (video.type !== 'Video' || !video.id || seen.has(video.id)) continue;
      seen.add(video.id);
      const title: string = video.title?.text ?? video.title?.toString?.() ?? '';
      const durationSec: number = video.duration?.seconds ?? 0;
      if (!durationSec || !KARAOKE_RE.test(title)) continue;
      if (video.is_live || video.is_upcoming) continue;
      results.push({
        videoId: video.id,
        title,
        thumbnail: `https://i.ytimg.com/vi/${video.id}/mqdefault.jpg`,
        durationSec,
        channel: video.author?.name ?? '',
      });
    }
    // an empty answer is not cached for long: it may just be a hiccup
    cache.set(key, { at: results.length ? Date.now() : Date.now() - CACHE_MS + 60_000, results });
    if (cache.size > 500) cache.delete(cache.keys().next().value!);
  }
  return results.filter((r) => r.durationSec <= maxDurationSec);
}

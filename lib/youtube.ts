import 'server-only';
import type { SearchResult } from './types';

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

export async function searchKaraoke(query: string, maxDurationSec: number): Promise<SearchResult[]> {
  const q = query.trim().toLowerCase();
  const key = q;
  let results: SearchResult[];
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    results = hit.results;
  } else {
    const client = await yt();
    const term = KARAOKE_RE.test(q) ? q : `${q} karaoke`;
    const res = await client.search(term, { type: 'video' });
    results = [];
    for (const v of res.videos) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const video = v as any;
      if (video.type !== 'Video' || !video.id) continue;
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
    cache.set(key, { at: Date.now(), results });
    if (cache.size > 500) cache.delete(cache.keys().next().value!);
  }
  return results.filter((r) => r.durationSec <= maxDurationSec);
}

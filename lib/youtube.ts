import 'server-only';
import type { SearchResult } from './types';
import { timeoutSignal, withTimeout } from './timeout';

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

import { KARAOKE_RE, NOT_KARAOKE_RE } from './song';
export { KARAOKE_RE };

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

/** "4:13" or "1:02:03" in seconds; 0 for anything else ("AO VIVO", "SHORTS"...). */
function clockSeconds(text: string): number {
  if (!/^\d{1,2}(:\d{2}){1,2}$/.test(text)) return 0;
  return text.split(':').reduce((t, n) => t * 60 + Number(n), 0);
}

/**
 * One search result in either layout YouTube sends: the classic `Video` or the newer `LockupView`
 * (YouTube tries it on some sessions; once a server's session gets it, every result comes that
 * way). Null for anything that is not a plain video (channels, playlists, shorts...).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function readItem(node: any): (SearchResult & { live: boolean }) | null {
  if ((node?.type === 'Video' || node?.type === 'CompactVideo' || node?.type === 'GridVideo') && node.id) {
    return {
      videoId: node.id,
      title: node.title?.text ?? node.title?.toString?.() ?? '',
      thumbnail: `https://i.ytimg.com/vi/${node.id}/mqdefault.jpg`,
      durationSec: node.duration?.seconds ?? clockSeconds(String(node.duration?.text ?? node.duration ?? '')),
      channel: node.author?.name ?? '',
      live: !!(node.is_live || node.is_upcoming),
    };
  }
  if (node?.type === 'LockupView' && node.content_type === 'VIDEO' && node.content_id) {
    const id: string = node.content_id;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const badges: any[] = (node.content_image?.overlays ?? []).flatMap((o: any) => o?.badges ?? []);
    const badgeText = badges.map((b) => String(b?.text ?? ''));
    const durationSec = badgeText.map(clockSeconds).find((n) => n > 0) ?? 0;
    const live = badges.some((b) => /LIVE/i.test(String(b?.badge_style ?? '')));
    const firstRow = node.metadata?.metadata?.metadata_rows?.[0]?.metadata_parts?.[0];
    return {
      videoId: id,
      title: String(node.metadata?.title?.text ?? ''),
      thumbnail: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
      durationSec,
      channel: String(firstRow?.avatar_stack?.text?.text ?? firstRow?.text?.text ?? ''),
      live,
    };
  }
  return null;
}

/** One search, read into songs. `readable` = how many results this code could read at all. */
async function readSearch(term: string) {
  const res = await searchOnce(term);
  const seen = new Set<string>();
  const results: SearchResult[] = [];
  for (const v of res.videos) {
    const item = readItem(v);
    if (!item || seen.has(item.videoId)) continue;
    seen.add(item.videoId);
    const { live, ...song } = item;
    if (live || !song.durationSec || !KARAOKE_RE.test(song.title) || NOT_KARAOKE_RE.test(song.title)) continue;
    results.push(song);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const types = [...new Set(((res as any).results ?? []).map((r: { type?: string }) => r?.type))].slice(0, 5);
  return { results, readable: seen.size, types };
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
    const startedAt = Date.now();
    let read;
    try {
      read = await readSearch(term);
      // Nothing readable at all (a layout this code does not know yet, or an odd answer): the
      // layout sticks to the session, so ask again right away with a brand-new one.
      if (!read.readable && Date.now() - startedAt < 9000) {
        console.error('search: nothing readable, trying a new session', read.types);
        ytPromise = null;
        read = await readSearch(term);
        if (!read.readable) {
          console.error('search: still nothing readable', read.types);
          ytPromise = null;
        }
      }
    } catch (first) {
      console.error('search failed', first);
      try {
        // one more try with a new session, unless the person has already waited too long
        if (Date.now() - startedAt > 9000) throw first;
        read = await readSearch(term);
      } catch (e) {
        // YouTube is not answering: an old answer for the same search is better than an error
        if (hit) return hit.results.filter((r) => r.durationSec <= maxDurationSec);
        throw e;
      }
    }
    results = read.results;
    // an empty answer is not remembered: it may just be a hiccup
    if (results.length) {
      cache.set(key, { at: Date.now(), results });
      if (cache.size > 500) cache.delete(cache.keys().next().value!);
    }
  }
  return results.filter((r) => r.durationSec <= maxDurationSec);
}

export interface LinkedVideo extends SearchResult {
  /** false when YouTube says the owner does not allow the video outside youtube.com */
  embeddable: boolean;
  live: boolean;
}

const linkCache = new Map<string, { at: number; video: LinkedVideo | null }>();
const LINK_BUDGET_MS = 18000; // the phone gives up at 24 s

function remember(videoId: string, video: LinkedVideo | null) {
  linkCache.set(videoId, { at: Date.now(), video });
  if (linkCache.size > 500) linkCache.delete(linkCache.keys().next().value!);
}

/** ISO 8601 duration (PT4M13S) in seconds. */
function isoSeconds(d: string): number {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d ?? '');
  if (!m) return 0;
  return (+(m[1] ?? 0)) * 86400 + (+(m[2] ?? 0)) * 3600 + (+(m[3] ?? 0)) * 60 + (+(m[4] ?? 0));
}

/**
 * With YOUTUBE_API_KEY set on Vercel, the official YouTube Data API answers first (free key, made
 * for servers, not blocked like the unofficial one). `undefined` = could not ask; `null` = YouTube
 * says the video does not exist.
 */
async function officialVideo(videoId: string): Promise<LinkedVideo | null | undefined> {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) return undefined;
  try {
    const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,status&id=${videoId}&key=${encodeURIComponent(apiKey)}`;
    const res = await fetch(url, { signal: timeoutSignal(5000), cache: 'no-store' });
    if (!res.ok) return undefined;
    const d = await res.json();
    const item = d?.items?.[0];
    if (!item) return null;
    const durationSec = isoSeconds(item.contentDetails?.duration ?? '');
    const live = item.snippet?.liveBroadcastContent && item.snippet.liveBroadcastContent !== 'none';
    return {
      videoId,
      title: String(item.snippet?.title ?? ''),
      thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
      durationSec,
      channel: String(item.snippet?.channelTitle ?? ''),
      embeddable: item.status?.embeddable !== false,
      live: !!live || durationSec === 0,
    };
  } catch {
    return undefined;
  }
}

/** Plan B without a key: search YouTube for the id itself (the search is blocked less often). */
async function videoFromSearch(videoId: string): Promise<LinkedVideo | null> {
  const res = await searchOnce(videoId);
  for (const v of res.videos) {
    const item = readItem(v);
    if (!item || item.videoId !== videoId) continue;
    if (!item.durationSec && !item.live) continue;
    const { live, ...song } = item;
    return { ...song, embeddable: true, live }; // embedding is checked again when the song is picked (lib/embed.ts)
  }
  return null;
}

/**
 * Title and length of one video, for a link the customer pasted. Null when the video does not
 * exist. Throws when YouTube could not be asked (nothing is remembered then).
 */
export async function videoById(videoId: string): Promise<LinkedVideo | null> {
  const hit = linkCache.get(videoId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.video;
  const startedAt = Date.now();
  const left = () => LINK_BUDGET_MS - (Date.now() - startedAt);

  const official = await officialVideo(videoId);
  if (official !== undefined) {
    remember(videoId, official);
    return official;
  }

  // the unofficial way: video details first
  try {
    const client = await withTimeout(yt(), Math.min(8000, left()));
    let info;
    try {
      info = await withTimeout(client.getBasicInfo(videoId), Math.min(7000, left()));
    } catch (e) {
      ytPromise = null;
      throw e;
    }
    const b = info.basic_info;
    const status = info.playability_status?.status;
    if (b?.title && b.duration && status !== 'ERROR' && status !== 'LOGIN_REQUIRED') {
      const video: LinkedVideo = {
        videoId,
        title: b.title,
        thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
        durationSec: b.duration,
        channel: b.author ?? b.channel?.name ?? '',
        embeddable: info.playability_status?.embeddable !== false,
        live: !!(b.is_live || b.is_upcoming),
      };
      remember(videoId, video);
      return video;
    }
    // only a clear "this video does not exist" is remembered as not found
    if (status === 'ERROR' && !b?.title) {
      remember(videoId, null);
      return null;
    }
  } catch (e) {
    console.error('video info failed', e);
  }

  // blocked ("confirm you are not a robot") or odd answer: try the search, if there is time left
  if (left() < 3000) throw new Error('link lookup out of time');
  const found = await withTimeout(videoFromSearch(videoId), left());
  if (found) remember(videoId, found);
  // not found by the search is not proof the video does not exist: not remembered
  return found;
}

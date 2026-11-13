import 'server-only';
import { timeoutSignal } from './timeout';
import { isGifUrl, type GifResult } from './types';

// GIF search through GIPHY. Needs a free key in GIPHY_API_KEY (developers.giphy.com). Without the
// key the phones only offer the built-in stickers. The free key allows 100 calls per hour, so
// every answer is kept in memory for a while. Isolated here to make swapping the provider easy.

const API = 'https://api.giphy.com/v1/gifs';
const RATING = 'pg'; // nothing heavy on the bar's projector
const ID_RE = /^[A-Za-z0-9]{5,40}$/;

export const gifSearchEnabled = () => !!process.env.GIPHY_API_KEY;

interface Entry {
  preview: string;
  url: string;
  title: string;
}
const byId = new Map<string, Entry>();
const searches = new Map<string, { at: number; results: GifResult[] }>();
const SEARCH_CACHE_MS = 60 * 60 * 1000;

function remember(id: string, e: Entry) {
  byId.set(id, e);
  if (byId.size > 3000) byId.delete(byId.keys().next().value!);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function parse(g: any): (GifResult & { url: string }) | null {
  const id = String(g?.id ?? '');
  const img = g?.images ?? {};
  const url = String(img.fixed_height?.url ?? img.downsized?.url ?? '');
  const preview = String(img.fixed_height_small?.url ?? img.fixed_width_small?.url ?? url);
  if (!ID_RE.test(id) || !isGifUrl(url) || !isGifUrl(preview)) return null;
  const rating = String(g?.rating ?? '').toLowerCase();
  if (rating && !['g', 'pg', 'y'].includes(rating)) return null;
  return { id, url, preview, title: String(g?.title ?? '').slice(0, 80) };
}

async function call(path: string, params: Record<string, string>): Promise<any> {
  const qs = new URLSearchParams({ api_key: process.env.GIPHY_API_KEY ?? '', rating: RATING, ...params });
  const res = await fetch(`${API}${path}?${qs}`, { signal: timeoutSignal(6000), cache: 'no-store' });
  if (!res.ok) throw new Error(`giphy ${res.status}`);
  return res.json();
}

/** Search (or what is trending, when `q` is empty). An old answer is better than an error. */
export async function searchGifs(q: string): Promise<GifResult[]> {
  const term = q.trim().toLowerCase().slice(0, 50);
  const hit = searches.get(term);
  if (hit && Date.now() - hit.at < SEARCH_CACHE_MS) return hit.results;
  try {
    const d = term
      ? await call('/search', { q: term, limit: '24', lang: 'pt' })
      : await call('/trending', { limit: '24' });
    const results: GifResult[] = [];
    for (const g of Array.isArray(d?.data) ? d.data : []) {
      const p = parse(g);
      if (!p) continue;
      remember(p.id, p);
      results.push({ id: p.id, preview: p.preview, title: p.title });
    }
    searches.set(term, { at: Date.now(), results });
    if (searches.size > 300) searches.delete(searches.keys().next().value!);
    return results;
  } catch (e) {
    if (hit) return hit.results;
    throw e;
  }
}

/** The address to show on the projector for a GIF id, or null if it does not exist / is not allowed. */
export async function gifUrl(id: string): Promise<string | null> {
  if (!ID_RE.test(id)) return null;
  const known = byId.get(id);
  if (known) return known.url;
  // another server instance did the search: ask GIPHY about this one (also re-checks the rating)
  const d = await call(`/${id}`, {});
  const p = parse(d?.data);
  if (!p) return null;
  remember(p.id, p);
  return p.url;
}

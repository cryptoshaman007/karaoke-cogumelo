import { NextRequest } from 'next/server';
import { getSettings } from '@/lib/supabase-server';
import { checkAdmin, singerFromRequest } from '@/lib/auth';
import { SearchUnreadable, searchKaraoke, videoById } from '@/lib/youtube';
import { fallbackSearch } from '@/lib/searchFallback';
import { looksKaraoke, youtubeIdFrom } from '@/lib/song';
import { BLOCKED_VIDEOS_OK, NOT_EMBEDDABLE } from '@/lib/embed';
import { fail, json } from '@/lib/http';
import { allow } from '@/lib/rate';
import { signSong } from '@/lib/songsig';

export const dynamic = 'force-dynamic';
// room for a slow first try plus one retry; the phone gives up at 24 s
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  // Customers search with their token; the admin panel searches with its cookie.
  let rateKey: string | null = null;
  if ((await checkAdmin()) !== 'yes') {
    let singer;
    try {
      singer = await singerFromRequest(req);
    } catch {
      return fail('Deu uma travadinha aqui. Tenta de novo em instantes.', 503);
    }
    if (!singer || singer.status === 'blocked') return fail('Entre com seu nome primeiro', 401);
    rateKey = `search:${singer.id}`;
  }
  const q = (req.nextUrl.searchParams.get('q') ?? '').trim().slice(0, 100);
  if (q.length < 2) return json({ results: [] });
  if (rateKey) {
    if (!(await allow([{ key: rateKey, max: 20, windowSec: 60 }], true))) return fail('Calma aí! Espera um pouquinho pra buscar de novo.', 429);
  }
  const linked = youtubeIdFrom(q);
  if (linked) return fromLink(linked);
  let settings;
  try {
    settings = await getSettings();
  } catch {
    return fail('Deu uma travadinha aqui. Tenta de novo em instantes.', 503);
  }
  const max = settings.max_duration_sec;
  const t0 = Date.now();
  try {
    const results = await searchKaraoke(q, max);
    return json({ results: results.map(signSong), maxDurationSec: max });
  } catch (e) {
    console.error('search failed, using plan B', e);
    // YouTube failed or changed its answer: plan B (official search with a key, then the songs
    // already sung at the bar), so the customers never get stuck without a song
    // (the official search only if there is still time: the phone gives up at 24 s)
    const b = await fallbackSearch(q, max, Date.now() - t0 < 12000);
    if (b.results.length || e instanceof SearchUnreadable) {
      return json({ results: b.results.map(signSong), maxDurationSec: max, fallback: b.source });
    }
    return fail('A busca do YouTube tá fora do ar agora. Tenta de novo, ou cola o link do YouTube aqui em cima.', 502);
  }
}

/** The customer pasted a YouTube link: that one video, with the same length limit as the search. */
async function fromLink(videoId: string) {
  let settings, video;
  try {
    settings = await getSettings();
    video = await videoById(videoId);
  } catch (e) {
    console.error('link lookup failed', e);
    return fail('Não consegui abrir esse link agora. Tenta de novo em instantes.', 502);
  }
  if (!video) return fail('Não achei esse vídeo. Confere se o link tá certo.', 404);
  if (video.live) return fail('Esse link é de uma live. Escolhe um vídeo normal de karaokê.', 422);
  if (!video.embeddable && !BLOCKED_VIDEOS_OK) return fail(NOT_EMBEDDABLE, 422);
  const max = settings.max_duration_sec;
  if (video.durationSec > max) {
    return fail(`Esse vídeo é longo demais. Só músicas de até ${Math.floor(max / 60)} minutos.`, 422);
  }
  const { embeddable: _e, live: _l, ...result } = video;
  return json({ results: [signSong(result)], maxDurationSec: max, fromLink: true, karaoke: looksKaraoke(video.title) });
}

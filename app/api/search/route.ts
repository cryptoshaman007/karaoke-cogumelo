import { NextRequest } from 'next/server';
import { getSettings } from '@/lib/supabase-server';
import { isAdmin, singerFromRequest } from '@/lib/auth';
import { KARAOKE_RE, searchKaraoke, videoById } from '@/lib/youtube';
import { youtubeIdFrom } from '@/lib/song';
import { NOT_EMBEDDABLE } from '@/lib/embed';
import { fail, json } from '@/lib/http';
import { recordHit, tooMany } from '@/lib/rate';

export const dynamic = 'force-dynamic';
// room for a slow first try plus one retry; the phone gives up at 24 s
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  // Customers search with their token; the admin panel searches with its cookie.
  let rateKey: string | null = null;
  if (!(await isAdmin())) {
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
    if (await tooMany(rateKey, 20, 60)) return fail('Calma aí! Espera um pouquinho pra buscar de novo.', 429);
    void recordHit(rateKey);
  }
  const linked = youtubeIdFrom(q);
  if (linked) return fromLink(linked);
  try {
    const settings = await getSettings();
    const results = await searchKaraoke(q, settings.max_duration_sec);
    return json({ results, maxDurationSec: settings.max_duration_sec });
  } catch (e) {
    console.error('search failed', e);
    return fail('A busca falhou. Tenta de novo em instantes.', 502);
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
  if (!video.embeddable) return fail(NOT_EMBEDDABLE, 422);
  const max = settings.max_duration_sec;
  if (video.durationSec > max) {
    return fail(`Esse vídeo é longo demais. Só músicas de até ${Math.floor(max / 60)} minutos.`, 422);
  }
  const { embeddable: _e, live: _l, ...result } = video;
  return json({ results: [result], maxDurationSec: max, fromLink: true, karaoke: KARAOKE_RE.test(video.title) });
}

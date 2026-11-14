import type { Settings } from './types';

/** Words that mark a karaoke version in a video title. */
export const KARAOKE_RE = /karaok[eê]|videok[eê]|sing ?along|vers[aã]o karaok/i;
/**
 * Titles that say it is the original recording even though "karaokê" is in them (a song called
 * "Karaokê", an arrocha with "karaokê" in the name...). Those are not karaoke versions.
 */
export const NOT_KARAOKE_RE = /clipe oficial|v[ií]deo ?clipe|v[ií]deo oficial|official (music )?video|[aá]udio oficial|official audio|lyric video|visualizer|\bshorts?\b/i;

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{6,20}$/;

export interface SongInput {
  video_id: string;
  title: string;
  thumbnail: string;
  duration_sec: number;
}

/** Validates a song sent by the browser. Returns an error message (pt-BR) or the clean row. */
export function parseSong(body: Record<string, unknown>, settings: Settings): SongInput | string {
  const videoId = String(body.videoId ?? '');
  const title = String(body.title ?? '').trim().slice(0, 200);
  const durationSec = Math.round(Number(body.durationSec));
  if (!VIDEO_ID_RE.test(videoId) || !title || !Number.isFinite(durationSec) || durationSec <= 0) {
    return 'Não deu pra usar essa música. Escolhe outra!';
  }
  if (durationSec > settings.max_duration_sec) {
    return `Essa é longa demais. Só músicas de até ${Math.floor(settings.max_duration_sec / 60)} minutos.`;
  }
  return {
    video_id: videoId,
    title,
    // never trust a thumbnail URL from the browser: it is shown on every screen
    thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
    duration_sec: durationSec,
  };
}

export function cleanName(raw: unknown): string {
  return String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 40);
}

const YT_ID = /^[A-Za-z0-9_-]{11}$/;

/**
 * The video id inside a YouTube link the customer pasted (youtube.com/watch?v=, youtu.be/,
 * /shorts/, /embed/, /live/, music. and m. addresses). Null when the text is not a YouTube link.
 */
export function youtubeIdFrom(input: string): string | null {
  const text = input.trim();
  if (!/youtu\.?be/i.test(text)) return null;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') id = url.pathname.split('/')[1] ?? null;
  else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'watch') id = url.searchParams.get('v');
    else if (['shorts', 'embed', 'live', 'v'].includes(parts[0] ?? '')) id = parts[1] ?? null;
  }
  return id && YT_ID.test(id) ? id : null;
}

/** Looks like a karaoke version (has the word, and does not say it is the original). */
export const looksKaraoke = (title: string) => KARAOKE_RE.test(title) && !NOT_KARAOKE_RE.test(title);

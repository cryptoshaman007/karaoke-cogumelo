import type { Settings } from './types';

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
    return 'Música inválida';
  }
  if (durationSec > settings.max_duration_sec) {
    return `Músicas de até ${Math.floor(settings.max_duration_sec / 60)} minutos`;
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

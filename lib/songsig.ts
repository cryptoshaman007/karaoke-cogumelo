import 'server-only';
import { createHmac, timingSafeEqual } from 'crypto';
import type { SearchResult } from './types';

// The phone sends back the song it picked (id, title, length). To stop anyone from inventing a
// title or a length, every song the server hands out (search, link, "mais cantadas") carries a
// signature, and the queue only takes songs whose signature matches.

function key(): string | null {
  const base = process.env.SUPABASE_SECRET_KEY || process.env.ADMIN_PASSWORD;
  return base ? createHmac('sha256', base).update('karaoke-song-sig-v1').digest('hex') : null;
}

function mac(k: string, videoId: string, title: string, durationSec: number) {
  return createHmac('sha256', k).update(`${videoId}\n${title}\n${Math.round(durationSec)}`).digest('base64url').slice(0, 32);
}

export function signSong<T extends Pick<SearchResult, 'videoId' | 'title' | 'durationSec'>>(song: T): T & { sig: string } {
  const k = key();
  return { ...song, sig: k ? mac(k, song.videoId, song.title, song.durationSec) : '' };
}

/** True when the song came from this server unchanged. Without a key configured (local tests) everything passes. */
export function songSigOk(videoId: string, title: string, durationSec: number, sig: unknown): boolean {
  const k = key();
  if (!k) return true;
  if (typeof sig !== 'string' || sig.length !== 32) return false;
  const want = Buffer.from(mac(k, videoId, title, durationSec));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

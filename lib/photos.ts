import 'server-only';
import { db } from './supabase-server';

// Selfies: a small square JPEG made on the phone, kept in the database only for the night.

/** A photo older than this is never shown and is deleted on the next upload. */
export const PHOTO_MAX_AGE_MS = 18 * 3600 * 1000;
/** Base64 length limit (about 60 KB of JPEG). The phone sends a 320×320 picture of ~20-30 KB. */
const MAX_B64 = 120_000;
const PREFIX = 'data:image/jpeg;base64,';

/** Checks what the phone sent. Returns the clean base64, or null when it is not a small JPEG. */
export function cleanJpeg(raw: unknown): string | null {
  const s = String(raw ?? '');
  if (!s.startsWith(PREFIX)) return null;
  const b64 = s.slice(PREFIX.length);
  if (!b64 || b64.length > MAX_B64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;
  const bytes = Buffer.from(b64, 'base64');
  // JPEG starts with FF D8 FF and ends with FF D9
  if (bytes.length < 200 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return null;
  if (bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return null;
  return b64;
}

/** Deletes one person's photo. Never throws. */
export async function removePhoto(singerId: string): Promise<boolean> {
  try {
    const sb = db();
    const a = await sb.from('singer_photos').delete().eq('singer_id', singerId);
    const b = await sb.from('singers').update({ photo_at: null }).eq('id', singerId);
    return !a.error && !b.error;
  } catch {
    return false;
  }
}

/** Throws away photos from earlier nights. Cheap, runs on each upload. Never throws. */
export async function dropOldPhotos(): Promise<void> {
  try {
    const sb = db();
    const old = new Date(Date.now() - PHOTO_MAX_AGE_MS).toISOString();
    const { data } = await sb.from('singer_photos').delete().lt('created_at', old).select('singer_id');
    const ids = (data ?? []).map((r: { singer_id: string }) => r.singer_id);
    if (ids.length) await sb.from('singers').update({ photo_at: null }).in('id', ids);
  } catch {}
}

import 'server-only';
import { db, isMissingSchema } from './supabase-server';
import { forgetGuardCache } from './guard';
import type { Settings } from './types';

// "Zerar a noite": the queue of the night before must not be there when the bar opens again.
// The database function `reset_night` does it atomically. The automatic clean-up has no timer
// behind it: it is checked when the projector opens (and every few minutes while it is on) and
// when a customer picks a song.

const BRT_OFFSET_MS = -3 * 3600 * 1000; // Brasília has no daylight saving time

/** Cheap check before going to the database: has the reset hour passed since this night began? */
export function nightResetDue(s: Settings, now = Date.now()): boolean {
  if (s.night_reset_hour < 0 || !s.night_started_at) return false;
  const local = new Date(now + BRT_OFFSET_MS);
  let boundary = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), s.night_reset_hour) - BRT_OFFSET_MS;
  if (boundary > now) boundary -= 24 * 3600 * 1000;
  return new Date(s.night_started_at).getTime() < boundary;
}

export type NightResult = 'reset' | 'off' | 'fresh' | 'busy' | 'failed';

/** Automatic clean-up. Never throws: a failure here must not get in the way of anything. */
export async function autoResetNight(s: Settings): Promise<NightResult> {
  if (!nightResetDue(s)) return s.night_reset_hour < 0 ? 'off' : 'fresh';
  try {
    const { data, error } = await db().rpc('reset_night', { p_auto: true });
    if (error) return 'failed';
    if (data === 'reset') await endNightCode();
    return (data as NightResult) ?? 'failed';
  } catch {
    return 'failed';
  }
}

/** The admin's button. Works even on a database without the newer function (plain clean-up). */
export async function resetNightNow(): Promise<void> {
  const sb = db();
  const { error } = await sb.rpc('reset_night', { p_auto: false });
  await endNightCode();
  if (!error) return;
  if (!isMissingSchema(error)) throw error;
  await sb.from('reserves').delete().gte('id', 0); // ignored if the table does not exist
  const { error: e2 } = await sb.from('queue').update({ status: 'skipped' }).in('status', ['waiting', 'playing']);
  if (e2) throw e2;
  await sb.from('settings').update({ paused: false }).eq('id', 1);
}

/**
 * A new night goes back to the printed QR: the emergency code (migration 013) only lasts one night,
 * so nobody gets locked out the next day because it was left on. Never throws.
 */
async function endNightCode(): Promise<void> {
  try {
    await db().from('settings').update({ night_code_at: null }).eq('id', 1).not('night_code_at', 'is', null);
    forgetGuardCache();
  } catch {}
}

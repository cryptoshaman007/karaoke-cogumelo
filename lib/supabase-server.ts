import 'server-only';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { normalizeSettings, type Settings } from './types';
import { fetchWithTimeout } from './timeout';

let client: SupabaseClient | null = null;

/** Server-side client with the secret key. Bypasses RLS: only use in API routes. */
export function db(): SupabaseClient {
  if (!client) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SECRET_KEY;
    if (!url || !key) throw new Error('Faltam NEXT_PUBLIC_SUPABASE_URL ou SUPABASE_SECRET_KEY');
    client = createClient(url, key, { auth: { persistSession: false }, global: { fetch: fetchWithTimeout(8000) } });
  }
  return client;
}

export async function getSettings(): Promise<Settings> {
  const { data, error } = await db().from('settings').select('*').eq('id', 1).single();
  if (error) throw error;
  return normalizeSettings(data);
}

/**
 * Moves the queue forward (atomic in the database). `current` is the id the caller believes is
 * playing; if something else is already playing the database changes nothing.
 */
export async function advanceQueue(current: number | null, endStatus: 'done' | 'skipped'): Promise<number | null> {
  // what was playing before, to know afterwards if the queue really moved
  const pre = await db().from('queue').select('id').eq('status', 'playing').maybeSingle();
  const before = pre.error ? current : ((pre.data as { id: number } | null)?.id ?? null);
  const { data, error } = await db().rpc('advance_queue', { p_current: current, p_end_status: endStatus });
  if (error) throw error;
  let playing = (data as number | null) ?? null;
  // A new song never starts paused. A repeated "song ended" that changed nothing must not undo a
  // pause the admin just made, so only when the queue moved. Ignored if the column does not exist yet.
  if (playing !== before) await db().from('settings').update({ paused: false }).eq('id', 1).eq('paused', true);
  // Whoever just sang gets their reserve song at the end of the queue. If the queue was empty,
  // that reserve is the next song: start it right away.
  if ((await promoteReserves()) > 0 && playing == null) {
    const again = await db().rpc('advance_queue', { p_current: null, p_end_status: endStatus });
    if (!again.error) playing = (again.data as number | null) ?? null;
  }
  return playing;
}

/**
 * Moves reserve songs into the queue for everyone left without a song there. Returns how many
 * moved. Safe to call at any time; does nothing if the database is not updated yet.
 */
export async function promoteReserves(): Promise<number> {
  try {
    const { data, error } = await db().rpc('promote_reserves');
    return error ? 0 : Number(data) || 0;
  } catch {
    return 0;
  }
}

/** True when a database error means "the newer tables/functions are not installed yet". */
export function isMissingSchema(error: { code?: string } | null): boolean {
  return !!error && ['42703', '42883', '42P01', 'PGRST202', 'PGRST204', 'PGRST205'].includes(error.code ?? '');
}
export const NEEDS_MIGRATION = 'Essa função ainda precisa da atualização do banco de dados.';

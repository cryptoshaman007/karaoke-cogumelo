import 'server-only';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { normalizeSettings, type Settings } from './types';

let client: SupabaseClient | null = null;

/** Server-side client with the secret key. Bypasses RLS: only use in API routes. */
export function db(): SupabaseClient {
  if (!client) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SECRET_KEY;
    if (!url || !key) throw new Error('Faltam NEXT_PUBLIC_SUPABASE_URL ou SUPABASE_SECRET_KEY');
    client = createClient(url, key, { auth: { persistSession: false } });
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
  const { data, error } = await db().rpc('advance_queue', { p_current: current, p_end_status: endStatus });
  if (error) throw error;
  // A new song never starts paused. Ignored if the column does not exist yet.
  await db().from('settings').update({ paused: false }).eq('id', 1).eq('paused', true);
  return (data as number | null) ?? null;
}

/** True when a database error means "the newer tables/functions are not installed yet". */
export function isMissingSchema(error: { code?: string } | null): boolean {
  return !!error && ['42703', '42883', '42P01', 'PGRST202', 'PGRST204', 'PGRST205'].includes(error.code ?? '');
}
export const NEEDS_MIGRATION = 'Esta função precisa da atualização do banco de dados.';

import 'server-only';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

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

export async function getSettings() {
  const { data, error } = await db().from('settings').select('*').eq('id', 1).single();
  if (error) throw error;
  return data as { max_duration_sec: number; require_approval: boolean };
}

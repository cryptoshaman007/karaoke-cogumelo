'use client';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { fetchWithTimeout } from './timeout';

let client: SupabaseClient | null = null;

export function browserClient(): SupabaseClient {
  if (!client) {
    client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        auth: { persistSession: false },
        // a request that hangs on bad Wi-Fi is dropped, and the next refresh tries again
        global: { fetch: fetchWithTimeout(10000) },
      },
    );
  }
  return client;
}

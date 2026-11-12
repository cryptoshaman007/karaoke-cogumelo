import 'server-only';
import { NextRequest } from 'next/server';
import { db } from './supabase-server';

// Simple rate limiting stored in Postgres (serverless functions do not share memory).
// Fails open: if the table is missing or the database errors, nobody is blocked.

export function clientIp(req: NextRequest): string {
  return (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown';
}

export async function tooMany(key: string, max: number, windowSec: number): Promise<boolean> {
  try {
    const since = new Date(Date.now() - windowSec * 1000).toISOString();
    const { count, error } = await db()
      .from('rate_events')
      .select('id', { count: 'exact', head: true })
      .eq('key', key)
      .gte('at', since);
    if (error) return false;
    return (count ?? 0) >= max;
  } catch {
    return false;
  }
}

export async function recordHit(key: string): Promise<void> {
  try {
    await db().from('rate_events').insert({ key });
    if (Math.random() < 0.02) {
      const old = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
      await db().from('rate_events').delete().lt('at', old);
    }
  } catch {
    /* fail open */
  }
}

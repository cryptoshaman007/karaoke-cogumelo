import 'server-only';
import { NextRequest } from 'next/server';
import { db, isMissingSchema } from './supabase-server';

// Rate limiting stored in Postgres (serverless functions do not share memory).
// `allow` counts and records in one step inside the database (function rate_hit, migration 007),
// so many requests at the same instant cannot all slip past the count.

export function clientIp(req: NextRequest): string {
  return (req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown';
}

export interface Limit {
  key: string;
  max: number;
  windowSec: number;
}

/**
 * True when the request may go on (and it is counted). Every limit in the list must have room;
 * the first full one stops the check. On a database error the answer is `onError`: customers are
 * never blocked by a hiccup, the admin login is.
 */
export async function allow(limits: Limit[], onError: boolean): Promise<boolean> {
  for (const l of limits) {
    try {
      const { data, error } = await db().rpc('rate_hit', { p_key: l.key, p_max: l.max, p_window_sec: l.windowSec });
      if (error) {
        // database not updated yet: the old way (count, then record)
        if (isMissingSchema(error)) {
          if (!(await legacyAllow(l, onError))) return false;
          continue;
        }
        return onError;
      }
      if (data !== true) return false;
    } catch {
      return onError;
    }
  }
  return true;
}

async function legacyAllow(l: Limit, onError: boolean): Promise<boolean> {
  try {
    const since = new Date(Date.now() - l.windowSec * 1000).toISOString();
    const { count, error } = await db()
      .from('rate_events')
      .select('id', { count: 'exact', head: true })
      .eq('key', l.key)
      .gte('at', since);
    if (error) return onError;
    if ((count ?? 0) >= l.max) return false;
    const ins = await db().from('rate_events').insert({ key: l.key });
    return ins.error ? onError : true;
  } catch {
    return onError;
  }
}

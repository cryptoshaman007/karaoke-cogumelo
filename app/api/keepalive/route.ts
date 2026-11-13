import { NextRequest } from 'next/server';
import { db } from '@/lib/supabase-server';
import { fail, json } from '@/lib/http';

export const dynamic = 'force-dynamic';

/**
 * Called once a day by Vercel Cron (vercel.json). On Supabase's free plan a project with no
 * activity for a week is paused; this daily read keeps it awake even when the bar is closed for
 * a while. It also throws away old rate-limit records and expired admin sessions.
 * With CRON_SECRET set on Vercel, only Vercel's own call is accepted.
 */
export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret && req.headers.get('authorization') !== `Bearer ${secret}`) return fail('Não autorizado', 401);
  try {
    const { error } = await db().from('settings').select('id').eq('id', 1).single();
    if (error) throw error;
  } catch (e) {
    console.error('keepalive failed', e);
    return fail('O banco não respondeu.', 503);
  }
  const day = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  await Promise.allSettled([
    db().from('rate_events').delete().lt('at', day),
    db().from('admin_sessions').delete().lt('expires_at', new Date().toISOString()),
  ]);
  return json({ ok: true, at: new Date().toISOString() });
}

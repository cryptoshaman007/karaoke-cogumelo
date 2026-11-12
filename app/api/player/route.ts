import { NextRequest } from 'next/server';
import { db } from '@/lib/supabase-server';
import { isAdmin } from '@/lib/auth';
import { fail, json } from '@/lib/http';

/** Used by the projector screen (logged in as admin) to move to the next song. */
export async function POST(req: NextRequest) {
  if (!(await isAdmin())) return fail('Faça login no admin', 401);
  const body = await req.json().catch(() => ({}));
  const current = body.current == null ? null : Number(body.current);
  const endStatus = body.endStatus === 'skipped' ? 'skipped' : 'done';
  const { data, error } = await db().rpc('advance_queue', { p_current: current, p_end_status: endStatus });
  if (error) return fail(error.message, 500);
  return json({ playing: data });
}

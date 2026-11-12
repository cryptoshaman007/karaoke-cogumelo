import { NextRequest } from 'next/server';
import { advanceQueue } from '@/lib/supabase-server';
import { isAdmin } from '@/lib/auth';
import { fail, json, readBody } from '@/lib/http';

/** Used by the projector screen (logged in as admin) to move to the next song. */
export async function POST(req: NextRequest) {
  if (!(await isAdmin())) return fail('Faça login no admin', 401);
  const body = await readBody(req);
  const n = Number(body.current);
  const current = body.current == null || !Number.isFinite(n) ? null : n;
  const endStatus = body.endStatus === 'skipped' ? 'skipped' : 'done';
  try {
    return json({ playing: await advanceQueue(current, endStatus) });
  } catch (e) {
    return fail((e as Error).message, 500);
  }
}

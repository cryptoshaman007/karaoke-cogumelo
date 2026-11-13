import { NextRequest } from 'next/server';
import { advanceQueue } from '@/lib/supabase-server';
import { requireAdmin } from '@/lib/auth';
import { fail, json, readBody } from '@/lib/http';
import { claimTv, validTvId } from '@/lib/tvlock';

/** Used by the projector screen (logged in as admin) to move to the next song. */
export async function POST(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const body = await readBody(req);
  // a second screen (mirror) must never end the song of the one in charge
  if (validTvId(body.tv) && !(await claimTv(body.tv, false))) {
    return json({ error: 'Outro telão tá no comando.', notOwner: true }, 409);
  }
  const n = Number(body.current);
  const current = body.current == null || !Number.isFinite(n) ? null : n;
  const endStatus = body.endStatus === 'skipped' ? 'skipped' : 'done';
  try {
    return json({ playing: await advanceQueue(current, endStatus) });
  } catch (e) {
    return fail((e as Error).message, 500);
  }
}

import { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { fail, json, readBody } from '@/lib/http';
import { claimTv, holdsTv, validTvId } from '@/lib/tvlock';

export const dynamic = 'force-dynamic';

/**
 * The projector screen says "I am here" every few seconds. `owner: false` means another screen is
 * playing the karaoke: this one becomes a mirror. `force: true` is the "assumir o telão" button.
 * `passive: true` comes from a screen that is already a mirror: it never takes over by itself.
 */
export async function POST(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const body = await readBody(req);
  if (!validTvId(body.id)) return fail('Tela inválida');
  if (body.force === true) return json({ owner: await claimTv(body.id, true) });
  if (body.passive === true) return json({ owner: await holdsTv(body.id) });
  return json({ owner: await claimTv(body.id, false) });
}

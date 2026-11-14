import { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { fail, json, readBody } from '@/lib/http';
import { claimTv, holdsTv, reportExtension, tvStatus, validTvId } from '@/lib/tvlock';

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
  let owner: boolean;
  if (body.force === true) owner = await claimTv(body.id, true);
  else if (body.passive === true) owner = await holdsTv(body.id);
  else owner = await claimTv(body.id, false);
  // only the screen in charge says whether the Chrome extension is there
  if (owner && body.ext !== undefined) await reportExtension(body.ext);
  return json({ owner });
}

/** For the admin: is the projector on, and does it have the Chrome extension? */
export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;
  return json({ status: await tvStatus() });
}

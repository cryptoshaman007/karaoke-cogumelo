import { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { fail, json, readBody } from '@/lib/http';
import { claimTv, validTvId } from '@/lib/tvlock';

export const dynamic = 'force-dynamic';

/**
 * The projector screen says "I am here" every few seconds. `owner: false` means another screen is
 * playing the karaoke: this one becomes a mirror. `force: true` is the "assumir o telão" button.
 */
export async function POST(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const body = await readBody(req);
  if (!validTvId(body.id)) return fail('Tela inválida');
  return json({ owner: await claimTv(body.id, body.force === true) });
}

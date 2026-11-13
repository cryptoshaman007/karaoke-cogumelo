import 'server-only';
import { db } from './supabase-server';

// Only one projector screen drives the queue (migration 007, table tv_lock). Any doubt (database
// not updated, hiccup) says "yes": a projector must never stop because of this check.

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

export const validTvId = (id: unknown): id is string => typeof id === 'string' && ID_RE.test(id);

/** True when `id` is (or just became) the screen in charge. */
export async function claimTv(id: string, force: boolean): Promise<boolean> {
  try {
    const { data, error } = await db().rpc('claim_tv', { p_id: id, p_force: force });
    if (error) return true; // not updated yet (isMissingSchema) or a hiccup
    return data === true;
  } catch {
    return true;
  }
}

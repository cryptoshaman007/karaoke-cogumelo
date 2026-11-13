import { NextRequest } from 'next/server';
import { ADMIN_COOKIE, endAdminSession, requireAdmin } from '@/lib/auth';
import { json, readBody } from '@/lib/http';

/** "Sair" ends this browser's session. With `all: true`, every device (projector included) has to log in again. */
export async function POST(req: NextRequest) {
  const all = (await readBody(req)).all === true;
  if (all) {
    const denied = await requireAdmin();
    if (denied) return denied;
  }
  await endAdminSession(all);
  const res = json({ ok: true });
  res.cookies.delete(ADMIN_COOKIE);
  return res;
}

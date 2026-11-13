import { NextRequest } from 'next/server';
import { ADMIN_COOKIE, checkPassword, isAdmin, newAdminCookieValue } from '@/lib/auth';
import { fail, json, readBody } from '@/lib/http';
import { clientIp, recordHit, tooMany } from '@/lib/rate';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const body = await readBody(req);
  const key = `login:${clientIp(req)}`;
  // 8 wrong passwords in 15 minutes from the same connection locks the login for a while
  if (await tooMany(key, 8, 15 * 60)) return fail('Muitas tentativas. Respira e tenta de novo em alguns minutos.', 429);
  if (!checkPassword(String(body.password ?? ''))) {
    await recordHit(key);
    await new Promise((r) => setTimeout(r, 600));
    return fail('Senha errada. Tenta de novo.', 401);
  }
  const res = json({ ok: true });
  res.cookies.set(ADMIN_COOKIE, newAdminCookieValue(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 365,
  });
  return res;
}

export async function GET() {
  return json({ admin: await isAdmin() });
}

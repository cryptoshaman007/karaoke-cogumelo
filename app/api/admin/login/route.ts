import { NextRequest } from 'next/server';
import { ADMIN_COOKIE, checkPassword, newAdminCookieValue } from '@/lib/auth';
import { fail, json } from '@/lib/http';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (!checkPassword(String(body.password ?? ''))) {
    await new Promise((r) => setTimeout(r, 800));
    return fail('Senha incorreta', 401);
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
  const { isAdmin } = await import('@/lib/auth');
  return json({ admin: await isAdmin() });
}

import { NextRequest } from 'next/server';
import { ADMIN_COOKIE, checkAdmin, checkPassword, cookieOptions, newAdminCookieValue } from '@/lib/auth';
import { fail, json, readBody } from '@/lib/http';
import { allow, clientIp } from '@/lib/rate';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const body = await readBody(req);
  // Every attempt counts, in one step in the database: 8 per connection in 15 minutes, and at most
  // 40 per hour from everywhere together (so spreading the attempts over many addresses does not
  // help either). If the database cannot count, the login waits: better than no limit at all.
  const ok = await allow(
    [
      { key: `login:${clientIp(req)}`, max: 8, windowSec: 15 * 60 },
      { key: 'login:all', max: 40, windowSec: 60 * 60 },
    ],
    false,
  );
  if (!ok) return fail('Muitas tentativas. Respira e tenta de novo em alguns minutos.', 429);
  if (!checkPassword(String(body.password ?? ''))) {
    await new Promise((r) => setTimeout(r, 600));
    return fail('Senha errada. Tenta de novo.', 401);
  }
  let value: string;
  try {
    value = await newAdminCookieValue();
  } catch {
    return fail('Deu uma travadinha aqui. Tenta de novo em instantes.', 503);
  }
  const res = json({ ok: true });
  res.cookies.set(ADMIN_COOKIE, value, cookieOptions);
  return res;
}

/** Is this browser the admin? A database hiccup answers 503, so the screens retry instead of logging out. */
export async function GET() {
  const res = json({ admin: false });
  const r = await checkAdmin(res);
  if (r === 'error') return fail('Deu uma travadinha aqui. Tenta de novo em instantes.', 503);
  const out = json({ admin: r === 'yes' });
  // keep a renewed or upgraded cookie, if checkAdmin wrote one
  for (const c of res.cookies.getAll()) out.cookies.set(c);
  return out;
}

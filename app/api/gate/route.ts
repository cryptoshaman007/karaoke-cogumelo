import { NextRequest, NextResponse } from 'next/server';
import { checkAdmin } from '@/lib/auth';
import { cleanCode, CODE_COOKIE, codeCookieOptions, GATE_MESSAGES, gateReason, guardState } from '@/lib/guard';
import { fail, json, readBody } from '@/lib/http';
import { allow, clientIp } from '@/lib/rate';

export const dynamic = 'force-dynamic';

/** The singer's page asks if it may come in: { ok: true } or { gate: 'geo' | 'code', error }. */
export async function GET(req: NextRequest) {
  const reason = await gateReason(req);
  if (!reason || (await checkAdmin()) === 'yes') return json({ ok: true });
  return json({ gate: reason, error: GATE_MESSAGES[reason] });
}

/**
 * The night code, from the QR on the projector (?c=...) or typed by hand. A right code is kept in
 * a cookie for the night. Only wrong codes are counted, so the whole bar on one Wi-Fi can come in
 * at once while nobody can try codes until one works.
 */
export async function POST(req: NextRequest) {
  const code = cleanCode((await readBody(req)).code);
  const st = await guardState();
  if (!st.code) {
    const reason = await gateReason(req);
    return json(reason ? { gate: reason, error: GATE_MESSAGES[reason] } : { ok: true });
  }
  if (code && code === st.code) {
    const res = NextResponse.json({ ok: true });
    res.cookies.set(CODE_COOKIE, code, codeCookieOptions);
    const reason = await gateReason(req);
    // right code, but outside Brazil with "Só Brasil" on: still stopped (the cookie stays for later)
    if (reason === 'geo') return NextResponse.json({ gate: 'geo', error: GATE_MESSAGES.geo }, { headers: res.headers });
    return res;
  }
  const ok = await allow(
    [
      { key: `code-miss:${clientIp(req)}`, max: 20, windowSec: 10 * 60 },
      { key: 'code-miss:all', max: 200, windowSec: 10 * 60 },
    ],
    true,
  );
  if (!ok) return fail('Muita tentativa errada. Respira, espera uns minutinhos e escaneia o QR do telão.', 429);
  return fail(code ? 'Esse código não é o de hoje. Confere no telão, embaixo do QR.' : 'Digita o código que aparece no telão.', 400);
}

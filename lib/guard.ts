import 'server-only';
import { randomInt } from 'crypto';
import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { checkAdmin } from './auth';
import { db, isMissingSchema } from './supabase-server';

// Two switches in the admin against bots and people far away (migration 013):
//  * "Só Brasil": the customer routes only answer requests that Vercel places in Brazil
//    (header x-vercel-ip-country). Without the header (computer of a developer, preview) nothing is blocked.
//  * Night code (emergency): while on, the customer routes only answer phones that came through the
//    QR on the projector (link with ?c=CODE, kept in a cookie) or typed the code shown under it.
//    The printed QR on the walls stays the normal one and works again when the code is turned off
//    (or the night is reset).
// The admin (and the projector, which is logged in as admin) is never blocked.
// On any database trouble the guard lets people through: customers are never blocked by a hiccup.

export const CODE_COOKIE = 'karaoke_noite';
const CODE_LETTERS = 'ACDEFHJKMNPRTUVWXY3479'; // nothing that looks like something else (0/O, 1/I, 5/S...)
export const CODE_LENGTH = 5;

export type GateReason = 'geo' | 'code';

interface GuardState {
  onlyBrazil: boolean;
  code: string | null;
}

const CACHE_MS = 10 * 1000;
let cached: { at: number; state: GuardState } | null = null;

export function forgetGuardCache() {
  cached = null;
}

/** Current switches (cached for a few seconds per server). Never throws. */
export async function guardState(): Promise<GuardState> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.state;
  const state: GuardState = { onlyBrazil: false, code: null };
  try {
    const { data, error } = await db().from('settings').select('only_brazil, night_code_at').eq('id', 1).single();
    if (error) {
      if (!isMissingSchema(error)) return state; // hiccup: let people in, ask again next time
    } else {
      state.onlyBrazil = !!data?.only_brazil;
      if (data?.night_code_at) {
        const c = await db().from('night_code').select('code').eq('id', 1).maybeSingle();
        if (c.error) return state;
        state.code = (c.data?.code as string | undefined) ?? null;
      }
    }
  } catch {
    return state;
  }
  cached = { at: Date.now(), state };
  return state;
}

export function cleanCode(v: unknown): string {
  return String(v ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 12);
}

export function newNightCode(): string {
  let s = '';
  for (let i = 0; i < CODE_LENGTH; i++) s += CODE_LETTERS[randomInt(CODE_LETTERS.length)];
  return s;
}

export function countryOf(req: NextRequest): string | null {
  const c = req.headers.get('x-vercel-ip-country');
  return c ? c.toUpperCase() : null;
}

/** Why this request would be stopped (ignoring the admin), or null. */
export async function gateReason(req: NextRequest): Promise<GateReason | null> {
  const st = await guardState();
  if (st.onlyBrazil) {
    const country = countryOf(req);
    if (country && country !== 'BR') return 'geo';
  }
  if (st.code) {
    const mine = cleanCode((await cookies()).get(CODE_COOKIE)?.value);
    if (mine !== st.code) return 'code';
  }
  return null;
}

export const GATE_MESSAGES: Record<GateReason, string> = {
  geo: 'Opa! Esse karaokê é só pra quem tá no Cogumelo Bar, e parece que você tá fora do Brasil (ou usando VPN). Tá aqui no bar? Desliga a VPN e tenta de novo.',
  code: 'Hoje o karaokê tá com código especial! Escaneia o QR que aparece no telão (o das paredes não vale hoje).',
};

/** For the customer routes: null when the request may go on, otherwise the answer to send. */
export async function guardPublic(req: NextRequest): Promise<NextResponse | null> {
  const reason = await gateReason(req);
  if (!reason) return null;
  if ((await checkAdmin()) === 'yes') return null;
  return NextResponse.json({ error: GATE_MESSAGES[reason], gate: reason }, { status: 403 });
}

export const codeCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
  maxAge: 16 * 3600, // one night
};

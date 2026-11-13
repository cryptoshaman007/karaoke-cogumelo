import 'server-only';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { cookies } from 'next/headers';
import { NextRequest, NextResponse } from 'next/server';
import { db, isMissingSchema } from './supabase-server';
import type { Singer } from './types';

export const ADMIN_COOKIE = 'karaoke_admin';

// Admin login. Each login gets a random session ("crachá") kept in the table admin_sessions
// (migration 007): "Sair" really ends it, and "Sair de todos os aparelhos" ends all of them.
// The session renews itself while it is used, so the projector never asks for the password in the
// middle of a night just because a date passed.
//
// Before migration 007 the cookie was a fixed value computed from the password. It still works
// while the table does not exist, and once it exists an old cookie is swapped for a session on
// its next use (until LEGACY_UNTIL, after that it is refused).

const SESSION_PREFIX = 's1.';
const SESSION_DAYS = 180; // unused for this long: asks for the password again
const RENEW_AFTER_MS = 24 * 3600 * 1000; // renewed at most once a day
const COOKIE_MAX_AGE = 400 * 24 * 3600; // the longest a browser keeps a cookie
const LEGACY_UNTIL = Date.parse('2027-02-01T00:00:00Z');

function legacyToken(): string {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) throw new Error('ADMIN_PASSWORD não configurada');
  return createHmac('sha256', pw).update('karaoke-admin-v1').digest('hex');
}

function safeEqual(a: string, b: string) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function checkPassword(pw: string) {
  const real = process.env.ADMIN_PASSWORD ?? '';
  return real.length > 0 && safeEqual(pw, real);
}

export function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

export const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/',
  maxAge: COOKIE_MAX_AGE,
};

/** Creates a session and returns the cookie value. Without the table, the old fixed value. */
export async function newAdminCookieValue(): Promise<string> {
  const token = SESSION_PREFIX + randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 3600 * 1000).toISOString();
  const { error } = await db().from('admin_sessions').insert({ token_hash: hashToken(token), expires_at: expires });
  if (!error) return token;
  if (isMissingSchema(error)) return legacyToken();
  throw error;
}

// Recently confirmed sessions, so the projector's calls do not all go to the database.
// A logout on another server instance takes at most this long to reach this one.
const seen = new Map<string, number>();
const SEEN_MS = 60 * 1000;

export type AdminCheck = 'yes' | 'no' | 'error';

/**
 * Is this browser logged in as admin? 'error' means the database could not answer: callers must
 * not treat that as "logged out" (the projector would drop to the password screen).
 * When `res` is given, a renewed or upgraded cookie is written on it.
 */
export async function checkAdmin(res?: NextResponse): Promise<AdminCheck> {
  const c = (await cookies()).get(ADMIN_COOKIE)?.value;
  if (!c || c.length > 200) return 'no';

  if (!c.startsWith(SESSION_PREFIX)) {
    let ok = false;
    try {
      ok = safeEqual(c, legacyToken());
    } catch {
      return 'no';
    }
    if (!ok) return 'no';
    // old fixed cookie: fine while there is no session table; otherwise swap it for a session
    try {
      const probe = await db().from('admin_sessions').select('token_hash', { head: true, count: 'exact' }).limit(1);
      if (probe.error) return isMissingSchema(probe.error) ? 'yes' : 'error';
      if (Date.now() > LEGACY_UNTIL) return 'no';
      const fresh = await newAdminCookieValue();
      await setAdminCookie(fresh, res);
      return 'yes';
    } catch {
      return 'error';
    }
  }

  const hash = hashToken(c);
  const at = seen.get(hash);
  if (at && Date.now() - at < SEEN_MS) return 'yes';
  try {
    const { data, error } = await db().from('admin_sessions').select('last_seen_at, expires_at').eq('token_hash', hash).maybeSingle();
    if (error) return isMissingSchema(error) ? 'no' : 'error';
    if (!data || Date.parse(data.expires_at) < Date.now()) {
      seen.delete(hash);
      return 'no';
    }
    seen.set(hash, Date.now());
    if (seen.size > 200) seen.delete(seen.keys().next().value!);
    if (Date.now() - Date.parse(data.last_seen_at) > RENEW_AFTER_MS) {
      const expires = new Date(Date.now() + SESSION_DAYS * 24 * 3600 * 1000).toISOString();
      await db().from('admin_sessions').update({ last_seen_at: new Date().toISOString(), expires_at: expires }).eq('token_hash', hash);
      await setAdminCookie(c, res);
    }
    return 'yes';
  } catch {
    return 'error';
  }
}

async function setAdminCookie(value: string, res?: NextResponse) {
  if (res) return void res.cookies.set(ADMIN_COOKIE, value, cookieOptions);
  // inside a route handler the cookie store is writable (Next adds it to the answer)
  try {
    (await cookies()).set(ADMIN_COOKIE, value, cookieOptions);
  } catch {}
}

export async function isAdmin(): Promise<boolean> {
  return (await checkAdmin()) === 'yes';
}

/** For admin routes: null when allowed, otherwise the answer to send (401, or 503 on a hiccup). */
export async function requireAdmin(): Promise<NextResponse | null> {
  const r = await checkAdmin();
  if (r === 'yes') return null;
  if (r === 'error') return NextResponse.json({ error: 'Deu uma travadinha aqui. Tenta de novo em instantes.' }, { status: 503 });
  return NextResponse.json({ error: 'Faça login no admin' }, { status: 401 });
}

/** Ends this browser's session (or every session, `all`). Never throws. */
export async function endAdminSession(all: boolean): Promise<void> {
  try {
    if (all) {
      await db().from('admin_sessions').delete().gt('expires_at', '1970-01-01');
      seen.clear();
      return;
    }
    const c = (await cookies()).get(ADMIN_COOKIE)?.value;
    if (!c?.startsWith(SESSION_PREFIX)) return;
    const hash = hashToken(c);
    seen.delete(hash);
    await db().from('admin_sessions').delete().eq('token_hash', hash);
  } catch {}
}

export function newSingerToken() {
  return randomBytes(24).toString('base64url');
}

/** Finds the singer for the x-singer-token header. Throws if the database is unreachable. */
export async function singerFromRequest(req: NextRequest) {
  const token = req.headers.get('x-singer-token');
  if (!token || token.length > 100) return null;
  const { data, error } = await db()
    .from('singers')
    .select('id, name, status, created_at')
    .eq('token_hash', hashToken(token))
    .maybeSingle();
  // A database hiccup must not look like "unknown singer": the phone would throw its token away.
  if (error) throw error;
  return data as Singer | null;
}

import 'server-only';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { cookies } from 'next/headers';
import { NextRequest } from 'next/server';
import { db } from './supabase-server';

export const ADMIN_COOKIE = 'karaoke_admin';

function adminToken(): string {
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

export function newAdminCookieValue() {
  return adminToken();
}

export async function isAdmin(): Promise<boolean> {
  const c = (await cookies()).get(ADMIN_COOKIE)?.value;
  if (!c) return false;
  try {
    return safeEqual(c, adminToken());
  } catch {
    return false;
  }
}

export function newSingerToken() {
  return randomBytes(24).toString('base64url');
}

export function hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

/** Finds the singer for the x-singer-token header. */
export async function singerFromRequest(req: NextRequest) {
  const token = req.headers.get('x-singer-token');
  if (!token || token.length > 100) return null;
  const { data } = await db()
    .from('singers')
    .select('id, name, status, created_at')
    .eq('token_hash', hashToken(token))
    .maybeSingle();
  return data as { id: string; name: string; status: string; created_at: string } | null;
}

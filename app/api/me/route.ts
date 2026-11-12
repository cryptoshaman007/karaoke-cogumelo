import { NextRequest } from 'next/server';
import { singerFromRequest } from '@/lib/auth';
import { fail, json } from '@/lib/http';

export const dynamic = 'force-dynamic';

/** Tells the phone who it is. Queue position and the rest come live from Supabase. */
export async function GET(req: NextRequest) {
  let singer;
  try {
    singer = await singerFromRequest(req);
  } catch {
    return fail('Tente de novo em instantes', 503);
  }
  if (!singer) return fail('Não encontrado', 404);
  return json({ singer });
}

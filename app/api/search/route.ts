import { NextRequest } from 'next/server';
import { getSettings } from '@/lib/supabase-server';
import { isAdmin, singerFromRequest } from '@/lib/auth';
import { searchKaraoke } from '@/lib/youtube';
import { fail, json } from '@/lib/http';
import { recordHit, tooMany } from '@/lib/rate';

export const dynamic = 'force-dynamic';
// room for a slow first try plus one retry; the phone gives up at 24 s
export const maxDuration = 30;

export async function GET(req: NextRequest) {
  // Customers search with their token; the admin panel searches with its cookie.
  let rateKey: string | null = null;
  if (!(await isAdmin())) {
    let singer;
    try {
      singer = await singerFromRequest(req);
    } catch {
      return fail('Deu uma travadinha aqui. Tenta de novo em instantes.', 503);
    }
    if (!singer || singer.status === 'blocked') return fail('Entre com seu nome primeiro', 401);
    rateKey = `search:${singer.id}`;
  }
  const q = (req.nextUrl.searchParams.get('q') ?? '').trim().slice(0, 100);
  if (q.length < 2) return json({ results: [] });
  if (rateKey) {
    if (await tooMany(rateKey, 20, 60)) return fail('Calma aí! Espera um pouquinho pra buscar de novo.', 429);
    void recordHit(rateKey);
  }
  try {
    const settings = await getSettings();
    const results = await searchKaraoke(q, settings.max_duration_sec);
    return json({ results, maxDurationSec: settings.max_duration_sec });
  } catch (e) {
    console.error('search failed', e);
    return fail('A busca falhou. Tenta de novo em instantes.', 502);
  }
}

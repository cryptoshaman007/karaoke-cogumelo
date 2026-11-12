import { NextRequest } from 'next/server';
import { getSettings } from '@/lib/supabase-server';
import { singerFromRequest } from '@/lib/auth';
import { searchKaraoke } from '@/lib/youtube';
import { fail, json } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const singer = await singerFromRequest(req);
  if (!singer || singer.status === 'blocked') return fail('Entre com seu nome primeiro', 401);
  const q = (req.nextUrl.searchParams.get('q') ?? '').trim().slice(0, 100);
  if (q.length < 2) return json({ results: [] });
  try {
    const settings = await getSettings();
    const results = await searchKaraoke(q, settings.max_duration_sec);
    return json({ results, maxDurationSec: settings.max_duration_sec });
  } catch (e) {
    console.error('search failed', e);
    return fail('A busca falhou. Tente de novo em instantes.', 502);
  }
}

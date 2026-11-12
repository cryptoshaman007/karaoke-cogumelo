import { NextRequest } from 'next/server';
import { db, getSettings } from '@/lib/supabase-server';
import { hashToken, newSingerToken } from '@/lib/auth';
import { fail, json, readBody } from '@/lib/http';
import { clientIp, recordHit, tooMany } from '@/lib/rate';
import { cleanName } from '@/lib/song';

export async function POST(req: NextRequest) {
  const body = await readBody(req);
  const name = cleanName(body.name);
  if (!name) return fail('Digite seu nome');
  // Generous on purpose: the whole bar shares one Wi-Fi address.
  const key = `join:${clientIp(req)}`;
  if (await tooMany(key, 120, 10 * 60)) return fail('Muita gente entrando ao mesmo tempo. Tente em um minuto.', 429);
  let settings;
  try {
    settings = await getSettings();
  } catch {
    return fail('Não foi possível entrar agora. Tente de novo.', 503);
  }
  const token = newSingerToken();
  const { data, error } = await db()
    .from('singers')
    .insert({
      name,
      token_hash: hashToken(token),
      status: settings.require_approval ? 'pending' : 'approved',
    })
    .select('id, name, status, created_at')
    .single();
  if (error) return fail('Não foi possível entrar agora', 500);
  await recordHit(key);
  return json({ token, singer: data });
}

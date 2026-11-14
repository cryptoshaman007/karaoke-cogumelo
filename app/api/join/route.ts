import { NextRequest } from 'next/server';
import { guardPublic } from '@/lib/guard';
import { db, getSettings } from '@/lib/supabase-server';
import { hashToken, newSingerToken } from '@/lib/auth';
import { fail, json, readBody } from '@/lib/http';
import { allow, clientIp } from '@/lib/rate';
import { cleanName } from '@/lib/song';

export async function POST(req: NextRequest) {
  const gated = await guardPublic(req);
  if (gated) return gated;
  const body = await readBody(req);
  const name = cleanName(body.name);
  if (!name) return fail('Diz aí como a gente te chama');
  // Generous on purpose: the whole bar shares one Wi-Fi address. The second limit, for everyone
  // together, stops a script from filling the admin's approval list with fake names.
  const ok = await allow(
    [
      { key: `join:${clientIp(req)}`, max: 120, windowSec: 10 * 60 },
      { key: 'join:all', max: 300, windowSec: 10 * 60 },
    ],
    true,
  );
  if (!ok) return fail('Tá entrando muita gente ao mesmo tempo! Tenta de novo em um minutinho.', 429);
  let settings;
  try {
    settings = await getSettings();
  } catch {
    return fail('Não deu pra entrar agora. Tenta de novo.', 503);
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
  if (error) return fail('Não deu pra entrar agora. Tenta de novo.', 500);
  return json({ token, singer: data });
}

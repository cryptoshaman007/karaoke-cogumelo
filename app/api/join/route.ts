import { NextRequest } from 'next/server';
import { db, getSettings } from '@/lib/supabase-server';
import { hashToken, newSingerToken } from '@/lib/auth';
import { fail, json } from '@/lib/http';

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const name = String(body.name ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
  if (!name) return fail('Digite seu nome');
  const settings = await getSettings();
  const token = newSingerToken();
  const { data, error } = await db()
    .from('singers')
    .insert({
      name,
      token_hash: hashToken(token),
      status: settings.require_approval ? 'pending' : 'approved',
    })
    .select('id, name, status')
    .single();
  if (error) return fail('Não foi possível entrar agora', 500);
  return json({ token, singer: data });
}

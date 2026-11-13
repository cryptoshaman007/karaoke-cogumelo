import { NextRequest } from 'next/server';
import { getSettings } from '@/lib/supabase-server';
import { isAdmin } from '@/lib/auth';
import { fail, json, readBody } from '@/lib/http';
import { autoResetNight, resetNightNow } from '@/lib/night';

export const dynamic = 'force-dynamic';

/**
 * `reset`: the admin's "zerar a noite" button.
 * `auto`: asked by the projector when it opens and every few minutes. Only cleans when the
 * configured hour has passed and nobody sang in the last 45 minutes.
 */
export async function POST(req: NextRequest) {
  if (!(await isAdmin())) return fail('Faça login no admin', 401);
  const action = String((await readBody(req)).action ?? '');
  if (action === 'reset') {
    try {
      await resetNightNow();
      return json({ ok: true, result: 'reset' });
    } catch {
      return fail('Não deu para zerar agora. Tenta de novo.', 500);
    }
  }
  if (action === 'auto') {
    try {
      return json({ ok: true, result: await autoResetNight(await getSettings()) });
    } catch {
      return json({ ok: true, result: 'failed' });
    }
  }
  return fail('Ação inválida');
}

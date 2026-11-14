import { NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { forgetGuardCache, newNightCode } from '@/lib/guard';
import { fail, json, readBody } from '@/lib/http';
import { db, isMissingSchema, NEEDS_MIGRATION } from '@/lib/supabase-server';

export const dynamic = 'force-dynamic';

/** The night code, for the admin and the projector's QR. { code: null } = off (printed QR is valid). */
export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;
  const s = await db().from('settings').select('night_code_at').eq('id', 1).single();
  if (s.error) return isMissingSchema(s.error) ? json({ code: null, missing: true }) : fail('Deu uma travadinha aqui. Tenta de novo.', 503);
  if (!s.data?.night_code_at) return json({ code: null });
  const c = await db().from('night_code').select('code').eq('id', 1).maybeSingle();
  if (c.error) return fail('Deu uma travadinha aqui. Tenta de novo.', 503);
  return json({ code: (c.data?.code as string | undefined) ?? null });
}

/** `new`: makes a fresh code (the old one, and the printed QR, stop working). `off`: back to normal. */
export async function POST(req: NextRequest) {
  const denied = await requireAdmin();
  if (denied) return denied;
  const action = String((await readBody(req)).action ?? '');
  if (action === 'new') {
    const code = newNightCode();
    const up = await db().from('night_code').upsert({ id: 1, code, created_at: new Date().toISOString() });
    if (up.error) return isMissingSchema(up.error) ? fail(NEEDS_MIGRATION, 409) : fail('Não deu pra gerar o código. Tenta de novo.', 500);
    const s = await db().from('settings').update({ night_code_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq('id', 1);
    if (s.error) return isMissingSchema(s.error) ? fail(NEEDS_MIGRATION, 409) : fail('Não deu pra ligar o código. Tenta de novo.', 500);
    forgetGuardCache();
    return json({ code });
  }
  if (action === 'off') {
    const s = await db().from('settings').update({ night_code_at: null, updated_at: new Date().toISOString() }).eq('id', 1);
    if (s.error) return isMissingSchema(s.error) ? fail(NEEDS_MIGRATION, 409) : fail('Não deu pra desligar. Tenta de novo.', 500);
    forgetGuardCache();
    return json({ code: null });
  }
  return fail('Ação inválida');
}

import { NextRequest } from 'next/server';
import { db, getSettings, isMissingSchema, NEEDS_MIGRATION } from '@/lib/supabase-server';
import { isAdmin } from '@/lib/auth';
import { fail, json, readBody } from '@/lib/http';

export const dynamic = 'force-dynamic';

/** Live (partial) ranking of the contest that is running. Only the admin sees it before the end. */
export async function GET() {
  if (!(await isAdmin())) return fail('Faça login no admin', 401);
  let settings;
  try {
    settings = await getSettings();
  } catch {
    return fail('Deu uma travadinha aqui. Tenta de novo em instantes.', 503);
  }
  if (!settings.contest_id) return json({ contestId: null, standings: [] });
  const { data, error } = await db().rpc('contest_standings', { p_contest: settings.contest_id });
  if (error) return isMissingSchema(error) ? fail(NEEDS_MIGRATION, 409) : fail(error.message, 500);
  return json({ contestId: settings.contest_id, standings: data ?? [] });
}

export async function POST(req: NextRequest) {
  if (!(await isAdmin())) return fail('Faça login no admin', 401);
  const action = String((await readBody(req)).action ?? '');
  const sb = db();
  const done = (error: { code?: string; message: string } | null, extra: Record<string, unknown> = {}) =>
    error ? (isMissingSchema(error) ? fail(NEEDS_MIGRATION, 409) : fail(error.message, 500)) : json({ ok: true, ...extra });

  if (action === 'start') {
    const { data, error } = await sb.rpc('start_contest');
    return done(error, { contestId: data });
  }
  if (action === 'end') {
    const { data, error } = await sb.rpc('end_contest');
    return done(error, { standings: data ?? [] });
  }
  // take the results off the projector
  if (action === 'hide') {
    const { error } = await sb.from('settings').update({ results_contest_id: null }).eq('id', 1);
    return done(error);
  }
  return fail('Ação inválida');
}

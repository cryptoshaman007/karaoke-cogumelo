import { NextRequest } from 'next/server';
import { db, getSettings, isMissingSchema, NEEDS_MIGRATION } from '@/lib/supabase-server';
import { singerFromRequest } from '@/lib/auth';
import { fail, json, readBody } from '@/lib/http';
import { recordHit, tooMany } from '@/lib/rate';
import { cleanJpeg, dropOldPhotos, removePhoto } from '@/lib/photos';

export const dynamic = 'force-dynamic';

async function who(req: NextRequest) {
  try {
    return { singer: await singerFromRequest(req) };
  } catch {
    return { error: fail('Deu uma travadinha aqui. Tenta de novo em instantes.', 503) };
  }
}

/** The customer sends (or replaces) their selfie. */
export async function POST(req: NextRequest) {
  const { singer, error } = await who(req);
  if (error) return error;
  if (!singer) return fail('Entre com seu nome primeiro', 401);
  if (singer.status === 'blocked') return fail('Poxa, você não tá liberado hoje.', 403);
  let settings;
  try {
    settings = await getSettings();
  } catch {
    return fail('Deu uma travadinha aqui. Tenta de novo em instantes.', 503);
  }
  if (!settings.photos_enabled) return fail('As fotos estão desligadas hoje.', 403);
  const jpeg = cleanJpeg((await readBody(req)).jpeg);
  if (!jpeg) return fail('Não deu pra usar essa foto. Tenta tirar de novo.');
  const key = `photo:${singer.id}`;
  if (await tooMany(key, 8, 10 * 60)) return fail('Muita foto seguida! Espera uns minutinhos.', 429);
  void recordHit(key);

  const now = new Date().toISOString();
  const up = await db().from('singer_photos').upsert({ singer_id: singer.id, jpeg, created_at: now });
  if (up.error) return isMissingSchema(up.error) ? fail(NEEDS_MIGRATION, 409) : fail('Não deu pra salvar a foto. Tenta de novo.', 500);
  const { error: e2 } = await db().from('singers').update({ photo_at: now }).eq('id', singer.id);
  if (e2) return fail('Não deu pra salvar a foto. Tenta de novo.', 500);
  void dropOldPhotos();
  return json({ ok: true, photoAt: now });
}

/** "Apagar minha foto": it disappears from the projector, the queue and the ranking. */
export async function DELETE(req: NextRequest) {
  const { singer, error } = await who(req);
  if (error) return error;
  if (!singer) return fail('Entre com seu nome primeiro', 401);
  if (!(await removePhoto(singer.id))) return fail('Não deu pra apagar agora. Tenta de novo.', 500);
  return json({ ok: true });
}

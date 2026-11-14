import { NextRequest } from 'next/server';
import { db, isMissingSchema, NEEDS_MIGRATION } from '@/lib/supabase-server';
import { hashToken, singerFromRequest } from '@/lib/auth';
import { fail, json, readBody } from '@/lib/http';
import { allow } from '@/lib/rate';
import { gifSearchEnabled, gifUrl, searchGifs } from '@/lib/gifs';
import { PRESET_GIFS, presetGifUrl, STICKERS } from '@/lib/types';

export const dynamic = 'force-dynamic';

/** GIF search for the phone. `search: false` means only the stickers and the hand-picked GIFs are available. */
export async function GET(req: NextRequest) {
  if (!gifSearchEnabled()) return json({ search: false, results: [] });
  let singer;
  try {
    singer = await singerFromRequest(req);
  } catch {
    return fail('Tenta de novo em instantes', 503);
  }
  if (!singer || singer.status !== 'approved') return fail('Entre com seu nome primeiro', 401);
  const q = (req.nextUrl.searchParams.get('q') ?? '').trim().slice(0, 50);
  const key = `gifsearch:${singer.id}`;
  if (q) {
    if (!(await allow([{ key, max: 12, windowSec: 60 }], true))) return fail('Calma aí! Espera um pouquinho pra buscar de novo.', 429);
  }
  try {
    return json({ search: true, results: await searchGifs(q) });
  } catch (e) {
    console.error('gif search failed', e);
    return fail('A busca de GIF falhou. Tenta de novo daqui a pouco.', 502);
  }
}

/** A customer sends a sticker or a GIF to the projector. */
export async function POST(req: NextRequest) {
  const token = req.headers.get('x-singer-token');
  if (!token || token.length > 100) return fail('Entre com seu nome primeiro', 401);
  const body = await readBody(req);
  let kind: 'gif' | 'sticker';
  let ref: string;
  if (body.sticker != null) {
    const key = String(body.sticker);
    if (!STICKERS.some((s) => s.key === key)) return fail('Figurinha inválida');
    kind = 'sticker';
    ref = key;
  } else if (body.preset != null) {
    // one of the hand-picked GIFs: works without the GIPHY key
    const id = String(body.preset);
    if (!PRESET_GIFS.some((g) => g.id === id)) return fail('Esse GIF não pode ir pro telão. Escolhe outro!');
    kind = 'gif';
    ref = presetGifUrl(id);
  } else {
    if (!gifSearchEnabled()) return fail('Os GIFs não estão ligados.', 403);
    let url: string | null = null;
    try {
      url = await gifUrl(String(body.gif ?? ''));
    } catch {
      return fail('Não deu para mandar esse GIF agora. Tenta de novo.', 502);
    }
    if (!url) return fail('Esse GIF não pode ir pro telão. Escolhe outro!');
    kind = 'gif';
    ref = url;
  }
  const { data, error } = await db().rpc('send_gif', { p_token_hash: hashToken(token), p_kind: kind, p_ref: ref });
  if (error) return isMissingSchema(error) ? fail(NEEDS_MIGRATION, 409) : fail('Tenta de novo em instantes', 503);
  switch (data) {
    case 'ok':
      return json({ ok: true });
    case 'slow':
      return fail('Calma aí! Um de cada vez, espera uns segundinhos.', 429);
    case 'off':
      return fail('Os GIFs estão desligados agora.', 403);
    case 'pending':
      return fail('Só um instante: o admin ainda vai liberar sua entrada.', 403);
    case 'unknown':
      return fail('Entre com seu nome primeiro', 401);
    default:
      return fail('Você não pode mandar GIF.', 403);
  }
}

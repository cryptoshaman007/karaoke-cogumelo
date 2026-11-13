import 'server-only';
import { timeoutSignal } from './timeout';

// Some videos cannot be played outside youtube.com (the owner turned embedding off). The projector
// would only find out when it is that person's turn, and skip them. So we ask YouTube when the song
// is chosen. Any doubt (timeout, odd answer, YouTube refusing our server) lets the song through:
// the projector still skips a video that really fails.

const KNOWN_GOOD = 'M7lc1UVf-VE'; // YouTube's own player demo video
let control: { at: number; ok: boolean } | null = null;

async function oembedStatus(videoId: string): Promise<number> {
  const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`;
  const res = await fetch(url, { signal: timeoutSignal(2500), cache: 'no-store' });
  return res.status;
}

/** True when YouTube's answers can be trusted from this server (a normal video answers 200). */
async function checkWorks(): Promise<boolean> {
  if (control && Date.now() - control.at < 10 * 60 * 1000) return control.ok;
  let ok = false;
  try {
    ok = (await oembedStatus(KNOWN_GOOD)) === 200;
  } catch {}
  control = { at: Date.now(), ok };
  return ok;
}

/** False only when YouTube says for sure that this video cannot be embedded. */
export async function canEmbed(videoId: string): Promise<boolean> {
  try {
    if ((await oembedStatus(videoId)) !== 401) return true;
    return !(await checkWorks());
  } catch {
    return true;
  }
}

export const NOT_EMBEDDABLE = 'Esse vídeo não deixa tocar no telão. Escolhe outra versão da música!';

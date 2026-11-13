'use client';
import { fmtScore, scorePhrase } from './types';

// "Figurinha da nota": an image the customer shares on WhatsApp or Instagram after singing.
// Drawn on the phone (no server work), 1080×1350, the size Instagram and WhatsApp show whole.

const W = 1080;
const H = 1350;
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

export interface StickerData {
  name: string;
  title: string;
  /** night-ranking grade (5 to 10), or null when there is no grade */
  score: number | null;
  /** selfie address (same site), or null */
  photo: string | null;
}

/** "Evidências (Karaokê Version) - Chitãozinho" → "Evidências - Chitãozinho" */
export function cleanSongTitle(title: string): string {
  return title
    .replace(/[([{][^)\]}]*(karaok|videok|playback|instrumental|vers[aã]o|version|lyrics|letra)[^)\]}]*[)\]}]/gi, '')
    .replace(/\s*[|/]\s*(karaok|videok|playback).*$/i, '')
    .replace(/\b(karaok[eê]|videok[eê])\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s*[-–|]\s*$/, '')
    .trim() || title;
}

function loadImg(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** Breaks text into at most `max` lines that fit `width`; the last one gets "…" if cut. */
function lines(ctx: CanvasRenderingContext2D, text: string, width: number, max: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < words.length; i++) {
    const next = cur ? `${cur} ${words[i]}` : words[i];
    if (ctx.measureText(next).width <= width || !cur) {
      cur = next;
      continue;
    }
    out.push(cur);
    cur = words[i];
    if (out.length === max) {
      cur = '';
      let last = out[max - 1];
      while (last.length > 1 && ctx.measureText(`${last}…`).width > width) last = last.slice(0, -1);
      out[max - 1] = `${last.trimEnd()}…`;
      break;
    }
  }
  if (cur) out.push(cur);
  return out.slice(0, max);
}

/** Largest font size (down to `min`) at which `text` fits in one line. */
function fit(ctx: CanvasRenderingContext2D, text: string, weight: number, size: number, min: number, width: number) {
  let s = size;
  for (; s > min; s -= 4) {
    ctx.font = `${weight} ${s}px ${FONT}`;
    if (ctx.measureText(text).width <= width) break;
  }
  ctx.font = `${weight} ${s}px ${FONT}`;
  return s;
}

export async function drawSticker(d: StickerData, when = new Date()): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Seu celular não deixou montar a figurinha.');

  // background: dark, with a purple glow (same colors as the app)
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#1d1236');
  bg.addColorStop(0.55, '#0f0c1a');
  bg.addColorStop(1, '#0b0b0f');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W / 2, 470, 40, W / 2, 470, 620);
  glow.addColorStop(0, 'rgba(167,139,250,0.35)');
  glow.addColorStop(1, 'rgba(167,139,250,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  // header
  ctx.fillStyle = '#c4b5fd';
  ctx.font = `700 40px ${FONT}`;
  ctx.fillText('🍄  KARAOKÊ COGUMELO BAR', W / 2, 110);

  // photo (or a microphone when there is none)
  const cx = W / 2;
  const cy = 420;
  const r = 200;
  const img = d.photo ? await loadImg(d.photo) : null;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.closePath();
  ctx.fillStyle = '#1c1c24';
  ctx.fill();
  if (img) {
    ctx.clip();
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, cx - r, cy - r, r * 2, r * 2);
  }
  ctx.restore();
  if (!img) {
    ctx.font = `200px ${FONT}`;
    ctx.textBaseline = 'middle';
    ctx.fillText('🎤', cx, cy + 10);
    ctx.textBaseline = 'alphabetic';
  }
  ctx.lineWidth = 12;
  ctx.strokeStyle = '#a78bfa';
  ctx.beginPath();
  ctx.arc(cx, cy, r + 6, 0, Math.PI * 2);
  ctx.stroke();

  // name
  ctx.fillStyle = '#ededf2';
  fit(ctx, d.name, 800, 92, 48, W - 140);
  ctx.fillText(d.name, W / 2, 735);

  // song
  ctx.fillStyle = '#9494a6';
  ctx.font = `500 40px ${FONT}`;
  const song = lines(ctx, `cantou “${cleanSongTitle(d.title)}”`, W - 180, 2);
  song.forEach((l, i) => ctx.fillText(l, W / 2, 800 + i * 52));

  // the grade
  const top = song.length > 1 ? 945 : 905;
  if (d.score != null) {
    ctx.fillStyle = '#9494a6';
    ctx.font = `700 34px ${FONT}`;
    ctx.fillText('NOTA DA GALERA', W / 2, top);
    ctx.fillStyle = '#a78bfa';
    ctx.font = `900 190px ${FONT}`;
    ctx.fillText(fmtScore(d.score), W / 2, top + 175);
    ctx.fillStyle = '#ededf2';
    fit(ctx, scorePhrase(d.score), 700, 50, 32, W - 160);
    ctx.fillText(scorePhrase(d.score), W / 2, top + 285);
  } else {
    ctx.fillStyle = '#a78bfa';
    ctx.font = `900 96px ${FONT}`;
    ctx.fillText('Soltei a voz!', W / 2, top + 110);
    ctx.fillStyle = '#ededf2';
    ctx.font = `600 44px ${FONT}`;
    ctx.fillText('🎶 🍻 🎶', W / 2, top + 190);
  }

  // footer
  ctx.fillStyle = '#6b6b80';
  ctx.font = `500 32px ${FONT}`;
  const date = when.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  ctx.fillText(`Cogumelo Bar · ${date}`, W / 2, H - 60);

  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Não deu pra montar a figurinha.'))), 'image/png'),
  );
}

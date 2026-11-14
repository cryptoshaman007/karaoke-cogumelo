'use client';
import { fmtScore, type NightSong } from './types';

// "Figurinha da nota": an image the customer shares on WhatsApp or Instagram after singing.
// Drawn on the phone (no server work), 1080×1350, the size Instagram and WhatsApp show whole.

const W = 1080;
const H = 1350;
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

export interface NightStickerData {
  name: string;
  /** selfie address (same site), or null */
  photo: string | null;
  /** tonight's songs, best first; the first 3 are drawn */
  songs: NightSong[];
  /** index in STICKER_THEMES */
  theme?: number;
}

export const STICKER_THEMES = [
  { name: 'Roxo neon', bg: ['#1d1236', '#0f0c1a', '#0b0b0f'], accent: '#a78bfa', soft: '#c4b5fd', glow: '167,139,250' },
  { name: 'Pôr do sol', bg: ['#3a1424', '#1a0b14', '#0b0b0f'], accent: '#fb923c', soft: '#fdba74', glow: '251,146,60' },
  { name: 'Cogumelo verde', bg: ['#0f2a1c', '#0b1610', '#0b0b0f'], accent: '#4ade80', soft: '#86efac', glow: '74,222,128' },
  { name: 'Rosa choque', bg: ['#3a0f33', '#170a16', '#0b0b0f'], accent: '#f472b6', soft: '#f9a8d4', glow: '244,114,182' },
];

/** A fun title for the night, from the best grade and how many songs. */
export function nightHeadline(songs: NightSong[]): string {
  const best = songs.reduce((m, s) => Math.max(m, s.score ?? -1), -1);
  const cheers = songs.reduce((m, s) => Math.max(m, s.reactions), 0);
  if (best >= 9.5) return '👑 Lenda da noite';
  if (best >= 8.5) return '🔥 Arrasei no palco';
  if (songs.length >= 3) return '🎤 Não larguei o microfone';
  if (best >= 7) return '✨ Mandei muito bem';
  if (cheers >= 10) return '🙌 A galera pirou';
  return '🍻 Soltei a voz';
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

/** Rounded rectangle path. */
function rounded(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Same name, same confetti: a tiny seeded random. */
function seeded(text: string) {
  let h = 2166136261;
  for (const c of text) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    return ((h ^= h >>> 16) >>> 0) / 4294967296;
  };
}

const MEDALS = ['🥇', '🥈', '🥉'];

/**
 * "Figurinha da noite": the person's 3 best songs of the night (by grade, then reactions), with
 * "Estive no Cogumelo Bar e cantei...". Redrawn whenever a new song comes in.
 */
export async function drawNightSticker(d: NightStickerData, when = new Date()): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Seu celular não deixou montar a figurinha.');
  const t = STICKER_THEMES[(d.theme ?? 0) % STICKER_THEMES.length] ?? STICKER_THEMES[0];
  const top3 = d.songs.slice(0, 3);

  // background + glow
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, t.bg[0]);
  bg.addColorStop(0.55, t.bg[1]);
  bg.addColorStop(1, t.bg[2]);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W / 2, 280, 30, W / 2, 280, 560);
  glow.addColorStop(0, `rgba(${t.glow},0.38)`);
  glow.addColorStop(1, `rgba(${t.glow},0)`);
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  // confetti
  const rnd = seeded(d.name);
  const colors = [t.accent, t.soft, '#fde047', '#ededf2'];
  for (let i = 0; i < 46; i++) {
    const x = rnd() * W;
    const y = rnd() * H;
    if (x > 170 && x < W - 170 && y > 30 && y < H - 20) continue; // only on the edges, never over the text
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rnd() * Math.PI);
    ctx.globalAlpha = 0.35 + rnd() * 0.45;
    ctx.fillStyle = colors[i % colors.length];
    if (i % 3 === 0) {
      ctx.beginPath();
      ctx.arc(0, 0, 5 + rnd() * 6, 0, Math.PI * 2);
      ctx.fill();
    } else ctx.fillRect(-9, -4, 18 + rnd() * 10, 8);
    ctx.restore();
  }
  ctx.globalAlpha = 1;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  // header
  ctx.fillStyle = t.soft;
  ctx.font = `700 38px ${FONT}`;
  ctx.fillText('🍄  KARAOKÊ COGUMELO BAR', W / 2, 92);
  ctx.font = `60px ${FONT}`;
  ctx.fillStyle = '#ffffff';
  ctx.fillText('🎶', 110, 250);
  ctx.fillText('✨', W - 110, 210);

  // photo (or a microphone)
  const cx = W / 2;
  const cy = 265;
  const r = 120;
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
    ctx.font = `120px ${FONT}`;
    ctx.textBaseline = 'middle';
    ctx.fillText('🎤', cx, cy + 6);
    ctx.textBaseline = 'alphabetic';
  }
  ctx.lineWidth = 10;
  ctx.strokeStyle = t.accent;
  ctx.beginPath();
  ctx.arc(cx, cy, r + 6, 0, Math.PI * 2);
  ctx.stroke();

  // name + fun title
  ctx.fillStyle = '#ededf2';
  fit(ctx, d.name, 800, 84, 44, W - 140);
  ctx.fillText(d.name, W / 2, 470);
  ctx.fillStyle = t.accent;
  const head = nightHeadline(d.songs);
  fit(ctx, head, 800, 52, 34, W - 140);
  ctx.fillText(head, W / 2, 540);

  // "Estive no Cogumelo Bar e cantei:" + up to 3 songs
  const rowH = 140;
  const gap = 18;
  const block = 60 + top3.length * rowH + Math.max(0, top3.length - 1) * gap;
  let y = 600 + Math.max(0, (3 * rowH + 2 * gap + 60 - block) / 2);
  ctx.fillStyle = '#b4b4c4';
  ctx.font = `500 38px ${FONT}`;
  ctx.fillText(top3.length ? 'Estive no Cogumelo Bar e cantei:' : 'Estive no Cogumelo Bar!', W / 2, y + 30);
  y += 60;
  const x0 = 70;
  const w = W - 140;
  top3.forEach((s, i) => {
    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    rounded(ctx, x0, y, w, rowH, 28);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = i === 0 ? t.accent : 'rgba(255,255,255,0.10)';
    ctx.stroke();
    // medal
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `64px ${FONT}`;
    ctx.fillStyle = '#ffffff'; // emoji take the alpha of the fill color
    ctx.fillText(top3.length > 1 ? MEDALS[i] : '🎤', x0 + 68, y + rowH / 2 + 4);
    // grade (or cheers) on the right
    const right = x0 + w - 32;
    ctx.textAlign = 'right';
    let badgeW = 0;
    if (s.score != null) {
      ctx.fillStyle = t.accent;
      ctx.font = `900 70px ${FONT}`;
      ctx.fillText(fmtScore(s.score), right, y + rowH / 2 - 8);
      badgeW = Math.max(ctx.measureText(fmtScore(s.score)).width, 90);
      ctx.fillStyle = '#9494a6';
      ctx.font = `700 22px ${FONT}`;
      ctx.fillText('NOTA', right, y + rowH / 2 + 40);
    } else if (s.reactions > 0) {
      ctx.fillStyle = t.soft;
      ctx.font = `800 46px ${FONT}`;
      const txt = `🔥 ${s.reactions}`;
      ctx.fillText(txt, right, y + rowH / 2);
      badgeW = ctx.measureText(txt).width;
    }
    // title
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#ededf2';
    ctx.font = `650 36px ${FONT}`;
    const tx = x0 + 128;
    const tw = right - tx - (badgeW ? badgeW + 24 : 0);
    const ls = lines(ctx, cleanSongTitle(s.title), tw, 2);
    const ty = y + rowH / 2 + (ls.length > 1 ? -8 : 13);
    ls.forEach((l, k) => ctx.fillText(l, tx, ty + k * 44));
    y += rowH + gap;
  });
  ctx.textAlign = 'center';

  // how many songs, and the joke
  const total = d.songs.length;
  y += 22;
  if (total > 3) {
    ctx.fillStyle = '#9494a6';
    ctx.font = `600 32px ${FONT}`;
    ctx.fillText(`e mais ${total - 3} ${total - 3 === 1 ? 'música' : 'músicas'} 🎶`, W / 2, y + 10);
  }
  ctx.fillStyle = t.soft;
  ctx.font = `700 40px ${FONT}`;
  ctx.fillText(`${total} ${total === 1 ? 'música' : 'músicas'} · 0 vergonha 😎`, W / 2, H - 130);

  // footer
  ctx.fillStyle = '#6b6b80';
  ctx.font = `500 30px ${FONT}`;
  const date = when.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  ctx.fillText(`Cogumelo Bar · ${date}`, W / 2, H - 60);

  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Não deu pra montar a figurinha.'))), 'image/png'),
  );
}

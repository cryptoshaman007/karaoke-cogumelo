export type SingerStatus = 'pending' | 'approved' | 'blocked';
export type QueueStatus = 'waiting' | 'playing' | 'done' | 'skipped';

export interface Singer {
  id: string;
  name: string;
  status: SingerStatus;
  created_at: string;
}

export interface QueueItem {
  id: number;
  singer_id: string;
  video_id: string;
  title: string;
  thumbnail: string | null;
  duration_sec: number;
  status: QueueStatus;
  position: number;
  created_at: string;
  started_at: string | null;
  /** nota do ranking da noite (5,0 a 10,0), calculada pelo banco quando a música termina */
  score?: number | null;
  reaction_count?: number | null;
}

export interface Settings {
  id: number;
  max_duration_sec: number;
  require_approval: boolean;
  /** false = ninguém novo entra na fila (fim da noite) */
  queue_open: boolean;
  /** segundos de "próximo cantor" no telão antes de cada música */
  intermission_sec: number;
  /** recado que aparece no telão */
  tv_message: string;
  paused: boolean;
  volume: number;
  /** muda quando o admin pede para reiniciar a música atual */
  restart_at: string | null;
  /** campeonato em andamento (null = desligado) */
  contest_id: number | null;
  /** campeonato encerrado cujo resultado está no telão */
  results_contest_id: number | null;
  reactions_enabled: boolean;
  /** ranking da noite: nota no fim de cada música, pelas reações */
  ranking_enabled: boolean;
  /** ranking da noite aberto no telão */
  ranking_on_tv: boolean;
  /** GIFs e figurinhas enviados pelo celular */
  gifs_enabled: boolean;
  /** quando a noite atual começou (null = banco ainda sem a atualização) */
  night_started_at: string | null;
  /** hora (Brasília) da limpeza automática da fila; -1 = desligada */
  night_reset_hour: number;
  /** botão "adicionar pedido" no telão, para quem está sem celular */
  tv_add_enabled: boolean;
  /** quantas músicas cada pessoa pode ter ao mesmo tempo (1 na fila + reservas) */
  songs_per_person: number;
}

export const DEFAULT_SETTINGS: Settings = {
  id: 1,
  max_duration_sec: 360,
  require_approval: true,
  queue_open: true,
  intermission_sec: 8,
  tv_message: '',
  paused: false,
  volume: 100,
  restart_at: null,
  contest_id: null,
  results_contest_id: null,
  // off until the database says otherwise, so the buttons stay hidden if the columns are missing
  reactions_enabled: false,
  ranking_enabled: false,
  ranking_on_tv: false,
  gifs_enabled: false,
  night_started_at: null,
  night_reset_hour: -1,
  tv_add_enabled: false,
  songs_per_person: 1,
};

/** A song a singer left in reserve: it joins the end of the queue after their current one. */
export interface Reserve {
  id: number;
  video_id: string;
  title: string;
  thumbnail: string | null;
  duration_sec: number;
}

/** Fills in defaults, so the app keeps working even if the database is missing newer columns. */
export function normalizeSettings(raw: Partial<Settings> | null | undefined): Settings {
  const out: Settings = { ...DEFAULT_SETTINGS };
  if (!raw) return out;
  for (const k of Object.keys(out) as (keyof Settings)[]) {
    if (raw[k] !== undefined && raw[k] !== null) (out as unknown as Record<string, unknown>)[k] = raw[k];
  }
  return out;
}

export interface SearchResult {
  videoId: string;
  title: string;
  thumbnail: string;
  durationSec: number;
  channel: string;
}

export interface PopularSong extends SearchResult {
  count: number;
}

/**
 * One performance in a ranking (best first). Contest: `score` is the average of the 1-5 votes.
 * Night ranking: `score` is the 5-10 grade from the reactions and `votes` is how many reactions.
 */
export interface Standing {
  queue_id: number;
  name: string;
  title: string;
  video_id: string;
  votes: number;
  score: number | null;
  /** only in the night ranking: who sang */
  singer_id?: string;
}

export const REACTIONS = [
  { key: 'clap', emoji: '👏', label: 'Palmas' },
  { key: 'heart', emoji: '❤️', label: 'Coração' },
  { key: 'fire', emoji: '🔥', label: 'Fogo' },
  { key: 'cry', emoji: '😭', label: 'Chorando' },
] as const;
export type ReactionKey = (typeof REACTIONS)[number]['key'];

/** The five voting levels, index 0 = score 1. */
export const SCORE_EMOJIS = ['😬', '😐', '🙂', '😄', '🤩'] as const;
export const SCORE_LABELS = ['Desafinou', 'Mais ou menos', 'Legal', 'Muito bom', 'Arrasou'] as const;

export const fmtScore = (n: number | null) => (n == null ? '–' : n.toFixed(1).replace('.', ','));

/** Built-in animated stickers a customer can send to the projector (no outside service needed). */
export const STICKERS = [
  { key: 'arrasou', emoji: '🤩', text: 'Arrasou!' },
  { key: 'bis', emoji: '🔁', text: 'Bis! Bis!' },
  { key: 'solta', emoji: '🎤', text: 'Solta a voz!' },
  { key: 'lenda', emoji: '👑', text: 'Lenda!' },
  { key: 'chorei', emoji: '😭', text: 'Chorei' },
  { key: 'desafinou', emoji: '🙉', text: 'Desafinou!' },
  { key: 'brinde', emoji: '🍻', text: 'Um brinde!' },
  { key: 'cogumelo', emoji: '🍄', text: 'Cogumelo!' },
] as const;

/** A GIF found in the search, as the phone sees it. */
export interface GifResult {
  id: string;
  preview: string;
  title: string;
}

/** GIFs only ever come from GIPHY's image servers. Checked on the server and again on the projector. */
export function isGifUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && /^(media\d*|i)\.giphy\.com$/.test(u.hostname);
  } catch {
    return false;
  }
}

/** A short cheer for a night-ranking grade. */
export function scorePhrase(score: number): string {
  if (score >= 9.5) return 'Lenda do karaokê!';
  if (score >= 8.5) return 'Arrasou demais!';
  if (score >= 7.5) return 'Mandou muito bem!';
  if (score >= 6.5) return 'Mandou bem!';
  if (score >= 5.5) return 'Valeu a coragem!';
  return 'A plateia tava tímida…';
}

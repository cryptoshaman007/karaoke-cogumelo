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

/** One performance in a contest ranking (best first). `score` is the average of the 1-5 votes. */
export interface Standing {
  queue_id: number;
  name: string;
  title: string;
  video_id: string;
  votes: number;
  score: number | null;
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

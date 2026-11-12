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
};

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

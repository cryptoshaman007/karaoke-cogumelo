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
}

export interface SearchResult {
  videoId: string;
  title: string;
  thumbnail: string;
  durationSec: number;
  channel: string;
}

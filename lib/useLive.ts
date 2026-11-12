'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { browserClient } from './supabase-browser';
import { normalizeSettings, type QueueItem, type Settings, type Singer } from './types';

export interface LiveState {
  queue: QueueItem[]; // waiting + playing, ordered
  singers: Record<string, Singer>;
  settings: Settings | null;
  loaded: boolean;
  refresh: () => Promise<void>;
}

interface Options {
  /** admin panel: also load people waiting for approval and refused people */
  admin?: boolean;
  /** customer phone: always load this singer, even without a song in the queue */
  selfId?: string | null;
}

const SINGER_COLS = 'id, name, status, created_at';
const PENDING_WINDOW_MS = 12 * 3600 * 1000;

/** Live view of the queue, singers and settings via Supabase Realtime (read-only). */
export function useLive({ admin = false, selfId = null }: Options = {}): LiveState {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [singers, setSingers] = useState<Record<string, Singer>>({});
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loaded, setLoaded] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);
  const last = useRef({ q: '', s: '', st: '' });

  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    const sb = browserClient();
    const [q, st] = await Promise.all([
      sb.from('queue').select('*').in('status', ['waiting', 'playing']).order('position').order('id'),
      sb.from('settings').select('*').eq('id', 1).single(),
    ]);
    if (q.error || !q.data) return; // offline or hiccup: keep what is on screen
    const rows = q.data as QueueItem[];
    const ids = [...new Set(rows.map((r) => r.singer_id).concat(selfId ? [selfId] : []))];

    const singerQueries = [
      ids.length ? sb.from('singers').select(SINGER_COLS).in('id', ids) : Promise.resolve({ data: [], error: null }),
    ];
    if (admin) {
      const since = new Date(Date.now() - PENDING_WINDOW_MS).toISOString();
      singerQueries.push(
        sb.from('singers').select(SINGER_COLS).eq('status', 'pending').gte('created_at', since).order('created_at').limit(100),
        sb.from('singers').select(SINGER_COLS).eq('status', 'blocked').order('created_at', { ascending: false }).limit(50),
      );
    }
    const res = await Promise.all(singerQueries);
    if (mine !== seq.current) return; // a newer refresh already answered
    if (res.some((r) => r.error)) return;
    const map: Record<string, Singer> = {};
    for (const r of res) for (const s of (r.data ?? []) as Singer[]) map[s.id] = s;

    // only touch React state when something really changed
    const qs = JSON.stringify(rows);
    const ss = JSON.stringify(map);
    if (qs !== last.current.q) (last.current.q = qs), setQueue(rows);
    if (ss !== last.current.s) (last.current.s = ss), setSingers(map);
    if (st.data) {
      const norm = normalizeSettings(st.data as Partial<Settings>);
      const sts = JSON.stringify(norm);
      if (sts !== last.current.st) (last.current.st = sts), setSettings(norm);
    }
    setLoaded(true);
  }, [admin, selfId]);

  useEffect(() => {
    refresh();
    const sb = browserClient();
    const later = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(refresh, 150);
    };
    const ch = sb
      .channel(`karaoke-live-${Math.random().toString(36).slice(2)}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'queue' }, later)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'singers' }, later)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'settings' }, later)
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') refresh();
      });
    // safety net in case a realtime event is missed; paused while the tab is in the background
    const poll = setInterval(() => document.visibilityState === 'visible' && refresh(), 20000);
    const onWake = () => document.visibilityState === 'visible' && refresh();
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('online', onWake);
    return () => {
      if (timer.current) clearTimeout(timer.current);
      sb.removeChannel(ch);
      clearInterval(poll);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('online', onWake);
    };
  }, [refresh]);

  return { queue, singers, settings, loaded, refresh };
}

async function send(method: string, url: string, body: unknown, headers: Record<string, string>) {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('Sem conexão. Tente de novo.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? 'Algo deu errado. Tente de novo.');
  return data;
}

export const post = (url: string, body: unknown, headers: Record<string, string> = {}) => send('POST', url, body, headers);
export const del = (url: string, headers: Record<string, string> = {}) => send('DELETE', url, undefined, headers);

export const fmt = (s: number) => {
  const t = Math.max(0, Math.floor(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { browserClient } from './supabase-browser';
import type { QueueItem, Settings, Singer } from './types';

export interface LiveState {
  queue: QueueItem[]; // waiting + playing, ordered
  singers: Record<string, Singer>;
  settings: Settings | null;
  loaded: boolean;
  refresh: () => Promise<void>;
}

/** Live view of the queue, singers and settings via Supabase Realtime. */
export function useLive(): LiveState {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [singers, setSingers] = useState<Record<string, Singer>>({});
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loaded, setLoaded] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    const sb = browserClient();
    const [q, s, st] = await Promise.all([
      sb.from('queue').select('*').in('status', ['waiting', 'playing']).order('position').order('id'),
      sb.from('singers').select('id, name, status, created_at').order('created_at', { ascending: false }).limit(300),
      sb.from('settings').select('id, max_duration_sec, require_approval').eq('id', 1).single(),
    ]);
    if (q.data) setQueue(q.data as QueueItem[]);
    if (s.data) setSingers(Object.fromEntries((s.data as Singer[]).map((x) => [x.id, x])));
    if (st.data) setSettings(st.data as Settings);
    setLoaded(true);
  }, []);

  useEffect(() => {
    refresh();
    const sb = browserClient();
    const later = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(refresh, 150);
    };
    const ch = sb
      .channel('karaoke-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'queue' }, later)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'singers' }, later)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'settings' }, later)
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') refresh();
      });
    // safety net in case a realtime event is missed
    const poll = setInterval(refresh, 15000);
    const onVis = () => document.visibilityState === 'visible' && refresh();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      sb.removeChannel(ch);
      clearInterval(poll);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [refresh]);

  return { queue, singers, settings, loaded, refresh };
}

export async function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? 'Erro');
  return data;
}

export const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

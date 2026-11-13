'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { browserClient } from './supabase-browser';
import { timeoutSignal } from './timeout';
import { normalizeSettings, type QueueItem, type Settings, type Singer, type Standing } from './types';

export interface LiveState {
  queue: QueueItem[]; // waiting + playing, ordered
  singers: Record<string, Singer>;
  settings: Settings | null;
  /** final ranking of the contest whose results are on screen (null = nothing to show) */
  results: Standing[] | null;
  /** night ranking, best grade first (empty while the mode is off or nobody was graded yet) */
  ranking: Standing[];
  loaded: boolean;
  refresh: () => Promise<void>;
}

interface Options {
  /** admin panel: also load people waiting for approval and refused people */
  admin?: boolean;
  /** customer phone: always load this singer, even without a song in the queue */
  selfId?: string | null;
  /** projector screen: keeps polling even if the window is not the visible one */
  tv?: boolean;
}

const BASE_SINGER_COLS = 'id, name, status, created_at';
// photo_at comes with database update 006; without it the columns fall back to the basic ones
let singerCols = `${BASE_SINGER_COLS}, photo_at`;
const PENDING_WINDOW_MS = 12 * 3600 * 1000;
const ID_CHUNK = 80;
const POLL_MS = 20000;
const POLL_DOWN_MS = 5000;
const REBUILD_AFTER_MS = 60000;
const RANKING_SIZE = 20;

/** Live view of the queue, singers and settings via Supabase Realtime (read-only). */
export function useLive({ admin = false, selfId = null, tv = false }: Options = {}): LiveState {
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [singers, setSingers] = useState<Record<string, Singer>>({});
  const [settings, setSettings] = useState<Settings | null>(null);
  const [results, setResults] = useState<Standing[] | null>(null);
  const [ranking, setRanking] = useState<Standing[]>([]);
  const [loaded, setLoaded] = useState(false);
  const last = useRef({ q: '', s: '', st: '', r: 'null', rk: '[]' });
  const inflight = useRef<Promise<void> | null>(null);
  const again = useRef(false);
  const alive = useRef(true);

  const load = useCallback(async () => {
    const sb = browserClient();
    const [q, st] = await Promise.all([
      sb.from('queue').select('*').in('status', ['waiting', 'playing']).order('position').order('id'),
      sb.from('settings').select('*').eq('id', 1).single(),
    ]);
    if (q.error || !q.data) return; // offline or hiccup: keep what is on screen
    const rows = q.data as QueueItem[];
    const norm = st.data ? normalizeSettings(st.data as Partial<Settings>) : null;

    // night ranking: the graded songs of this night. A failure here only leaves the ranking as it was.
    let graded: QueueItem[] | null = norm && !norm.ranking_enabled ? [] : null;
    if (norm?.ranking_enabled) {
      let rq = sb.from('queue').select('id, singer_id, title, video_id, score, reaction_count').not('score', 'is', null);
      if (norm.night_started_at) rq = rq.gte('started_at', norm.night_started_at);
      const rk = await rq.order('score', { ascending: false }).order('reaction_count', { ascending: false }).order('id').limit(RANKING_SIZE);
      if (!rk.error && rk.data) graded = rk.data as QueueItem[];
    }
    const ids = [...new Set(rows.map((r) => r.singer_id).concat(selfId ? [selfId] : [], (graded ?? []).map((g) => g.singer_id)))];

    // in slices, so a very long queue never produces an address too long for the server
    const singerQueries = (cols: string) => {
      const list = [];
      for (let i = 0; i < ids.length; i += ID_CHUNK) {
        list.push(sb.from('singers').select(cols).in('id', ids.slice(i, i + ID_CHUNK)));
      }
      if (admin) {
        const since = new Date(Date.now() - PENDING_WINDOW_MS).toISOString();
        list.push(
          sb.from('singers').select(cols).eq('status', 'pending').gte('created_at', since).order('created_at').limit(100),
          sb.from('singers').select(cols).eq('status', 'blocked').order('created_at', { ascending: false }).limit(50),
        );
      }
      return Promise.all(list);
    };
    let [res, contest] = await Promise.all([
      singerQueries(singerCols),
      norm?.results_contest_id
        ? sb.from('contests').select('results').eq('id', norm.results_contest_id).maybeSingle()
        : Promise.resolve(null),
    ]);
    if (singerCols !== BASE_SINGER_COLS && res.some((r) => r.error?.code === '42703')) {
      singerCols = BASE_SINGER_COLS;
      res = await singerQueries(singerCols);
    }
    if (!alive.current) return;
    if (res.some((r) => r.error)) return;
    const map: Record<string, Singer> = {};
    for (const r of res) for (const s of (r.data ?? []) as unknown as Singer[]) map[s.id] = s;

    // only touch React state when something really changed
    const qs = JSON.stringify(rows);
    const ss = JSON.stringify(map);
    if (qs !== last.current.q) (last.current.q = qs), setQueue(rows);
    if (ss !== last.current.s) (last.current.s = ss), setSingers(map);
    if (graded) {
      const list: Standing[] = graded.map((g) => ({
        queue_id: g.id,
        singer_id: g.singer_id,
        name: map[g.singer_id]?.name ?? '…',
        title: g.title,
        video_id: g.video_id,
        votes: g.reaction_count ?? 0,
        score: g.score == null ? null : Number(g.score),
      }));
      const rks = JSON.stringify(list);
      if (rks !== last.current.rk) (last.current.rk = rks), setRanking(list);
    }
    if (norm) {
      const sts = JSON.stringify(norm);
      if (sts !== last.current.st) (last.current.st = sts), setSettings(norm);
      if (!contest || !contest.error) {
        const list = contest ? ((contest.data?.results as Standing[] | null) ?? []) : null;
        const rs = JSON.stringify(list);
        if (rs !== last.current.r) (last.current.r = rs), setResults(list);
      }
    }
    setLoaded(true);
  }, [admin, selfId]);

  // One load at a time. A request that arrives while another is running makes it run once more
  // at the end, so the newest state always wins and a slow connection never starves the screen.
  const refresh = useCallback((): Promise<void> => {
    if (inflight.current) {
      again.current = true;
      return inflight.current;
    }
    const run = async () => {
      do {
        again.current = false;
        try {
          await load();
        } catch (e) {
          console.error('refresh failed', e);
        }
      } while (again.current && alive.current);
    };
    const p = run().finally(() => {
      if (inflight.current === p) inflight.current = null;
    });
    inflight.current = p;
    return p;
  }, [load]);

  useEffect(() => {
    alive.current = true;
    const sb = browserClient();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let gen = 0;
    let ch: RealtimeChannel | null = null;
    let live = false; // realtime channel joined
    let downSince = Date.now();
    let lastPoll = Date.now();

    // phones wait a random moment, so a full bar does not hit the database in the same instant
    const later = () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        refresh();
      }, tv || admin ? 150 : 150 + Math.random() * 500);
    };

    const connect = () => {
      const mine = ++gen;
      ch = sb
        .channel(`karaoke-live-${Math.random().toString(36).slice(2)}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'queue' }, later)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'singers' }, later)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'settings' }, later)
        .subscribe((status) => {
          if (mine !== gen) return; // an old channel being closed
          const ok = status === 'SUBSCRIBED';
          if (live && !ok) downSince = Date.now();
          live = ok;
          if (ok) refresh();
        });
    };
    connect();
    refresh();

    // Safety net for missed realtime events. While realtime is down the screen polls faster, and
    // if it stays down for a minute the channel is rebuilt from scratch.
    const tick = setInterval(() => {
      const visible = tv || document.visibilityState === 'visible';
      if (!visible) return;
      const now = Date.now();
      if (!live && now - downSince > REBUILD_AFTER_MS) {
        downSince = now;
        const old = ch;
        connect();
        if (old) sb.removeChannel(old).catch(() => {});
      }
      if (now - lastPoll >= (live ? POLL_MS : POLL_DOWN_MS) - 500) {
        lastPoll = now;
        refresh();
      }
    }, POLL_DOWN_MS);
    const onWake = () => document.visibilityState === 'visible' && refresh();
    const onOnline = () => refresh();
    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('online', onOnline);
    return () => {
      alive.current = false;
      gen++;
      if (timer) clearTimeout(timer);
      if (ch) sb.removeChannel(ch).catch(() => {});
      clearInterval(tick);
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('online', onOnline);
    };
  }, [refresh, tv, admin]);

  return { queue, singers, settings, results, ranking, loaded, refresh };
}

/** Error from an /api call; `status` is the HTTP status (missing when the network failed). */
export type ApiError = Error & { status?: number };

export const REQUEST_TIMEOUT_MS = 12000;

async function send(method: string, url: string, body: unknown, headers: Record<string, string>) {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      cache: 'no-store',
      // never wait forever: a hung request would keep a button (or the whole queue) locked
      signal: timeoutSignal(REQUEST_TIMEOUT_MS),
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error('Sem internet por aqui. Tenta de novo.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err: ApiError = new Error(data.error ?? 'Ops, algo deu errado. Tenta de novo.');
    err.status = res.status;
    throw err;
  }
  return data;
}

export const get = (url: string, headers: Record<string, string> = {}) => send('GET', url, undefined, headers);
export const post = (url: string, body: unknown, headers: Record<string, string> = {}) => send('POST', url, body, headers);
export const del = (url: string, headers: Record<string, string> = {}) => send('DELETE', url, undefined, headers);

export const fmt = (s: number) => {
  const t = Math.max(0, Math.floor(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

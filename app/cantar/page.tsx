'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import GifSheet from '@/components/GifSheet';
import Ranking from '@/components/Ranking';
import SongSearch from '@/components/SongSearch';
import Avatar from '@/components/Avatar';
import { browserClient } from '@/lib/supabase-browser';
import { del, GATE_EVENT, get, post, put, useLive, type ApiError } from '@/lib/useLive';
import { selfieJpeg } from '@/lib/selfie';
import { cleanSongTitle, drawNightSticker, nightHeadline, STICKER_THEMES } from '@/lib/sticker';
import { SUGGESTIONS } from '@/lib/suggestions';
import { timeoutSignal } from '@/lib/timeout';
import { turnAlert, unlockSound } from '@/lib/turnAlert';
import { fmtScore, REACTIONS, SCORE_EMOJIS, SCORE_LABELS, scorePhrase, photoUrl, type NightSong, type QueueItem, type Reserve, type SearchResult, type Singer } from '@/lib/types';

const TOKEN_KEY = 'karaoke_token';
const LAST_SONG_KEY = 'karaoke_last_song';
const SELFIE_SKIP_KEY = 'karaoke_selfie_skip';
const THEME_KEY = 'karaoke_sticker_theme';

function readToken() {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
function writeToken(t: string | null) {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {}
}

export default function SingPage() {
  return (
    <Gate>
      <SingApp />
    </Gate>
  );
}

function SingApp() {
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [me, setMe] = useState<Singer | null>(null);

  useEffect(() => {
    setToken(readToken());
    setReady(true);
  }, []);

  // Ask the server who this phone is. Retries on network trouble; only forgets the token
  // when the server says for sure that it does not exist.
  useEffect(() => {
    if (!token || me) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const res = await fetch('/api/me', { headers: { 'x-singer-token': token }, cache: 'no-store', signal: timeoutSignal(10000) });
        if (stop) return;
        if (res.status === 404) {
          writeToken(null);
          setToken(null);
          return;
        }
        if (res.ok) {
          setMe((await res.json()).singer);
          return;
        }
      } catch {}
      if (!stop) timer = setTimeout(load, 3000);
    };
    load();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [token, me]);

  if (!ready) return <Loading />;
  if (!token)
    return (
      <Join
        onJoined={(t, singer) => {
          writeToken(t);
          setMe(singer);
          setToken(t);
        }}
      />
    );
  if (!me) return <Loading />;
  return <Room me={me} token={token} />;
}

type GateState = { kind: 'checking' } | { kind: 'ok' } | { kind: 'geo' | 'code'; msg: string };

/**
 * "Só Brasil" and the emergency night code (both switched in the admin). Before the page opens it
 * asks the server if this phone may come in. A link from the projector's QR carries the night code
 * (?c=...): it is handed to the server (which keeps it in a cookie) and taken off the address.
 * If an answer later says the phone was stopped (the code got switched on mid-night), this screen
 * comes back; the phone keeps its name and place in the queue once it is let in again.
 */
function Gate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<GateState>({ kind: 'checking' });

  const check = useCallback(async (code?: string) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const d = code ? await post('/api/gate', { code }) : await get('/api/gate');
        if (d.gate === 'geo' || d.gate === 'code') setState({ kind: d.gate, msg: d.error ?? '' });
        else setState({ kind: 'ok' });
        return;
      } catch (e) {
        const status = (e as ApiError).status;
        // a wrong code from an old QR: just ask for the right one
        if (code && status && status < 500) {
          setState({ kind: 'code', msg: (e as Error).message });
          return;
        }
        // trouble reaching the server: never lock anyone out because of it
        if (attempt >= 1) {
          setState({ kind: 'ok' });
          return;
        }
      }
    }
  }, []);

  useEffect(() => {
    let code = '';
    try {
      const url = new URL(window.location.href);
      code = url.searchParams.get('c') ?? '';
      if (code) {
        url.searchParams.delete('c');
        window.history.replaceState(null, '', url.pathname + url.search + url.hash);
      }
    } catch {}
    void check(code || undefined);
  }, [check]);

  useEffect(() => {
    const onGate = () => void check();
    window.addEventListener(GATE_EVENT, onGate);
    return () => window.removeEventListener(GATE_EVENT, onGate);
  }, [check]);

  if (state.kind === 'ok') return <>{children}</>;
  if (state.kind === 'checking') return <Loading />;
  return <GateScreen kind={state.kind} msg={state.msg} onCode={(c) => check(c)} onRetry={() => check()} />;
}

function GateScreen({ kind, msg, onCode, onRetry }: { kind: 'geo' | 'code'; msg: string; onCode: (code: string) => Promise<void>; onRetry: () => Promise<void> }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    try {
      await f();
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="center">
      <form
        className="card narrow"
        onSubmit={(e) => {
          e.preventDefault();
          if (kind === 'code') void run(() => onCode(code));
          else void run(onRetry);
        }}
      >
        <div className="brand">
          <span className="brand-mark">{kind === 'geo' ? '🌎' : '🔑'}</span>
          <div>
            <strong>{kind === 'geo' ? 'Só pra quem tá no bar' : 'Código da noite'}</strong>
            <span className="muted small">Karaokê Cogumelo</span>
          </div>
        </div>
        <p>{msg}</p>
        {kind === 'code' && (
          <label className="field">
            <span>Ou digita o código que aparece embaixo do QR do telão</span>
            <input
              className="code-input"
              placeholder="K7XP4"
              maxLength={12}
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
            />
          </label>
        )}
        <button className="btn primary block" disabled={busy || (kind === 'code' && code.trim().length < 3)}>
          {busy ? 'Conferindo…' : kind === 'code' ? 'Entrar' : 'Tentar de novo'}
        </button>
      </form>
    </main>
  );
}

function Loading() {
  return (
    <main className="center">
      <span className="spinner big" aria-label="Carregando" />
    </main>
  );
}

function Join({ onJoined }: { onJoined: (token: string, singer: Singer) => void }) {
  const [name, setName] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <main className="center">
      <form
        className="card narrow"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setErr('');
          try {
            const d = await post('/api/join', { name });
            onJoined(d.token, d.singer);
          } catch (e) {
            setErr((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="brand">
          <span className="brand-mark">🍄</span>
          <div>
            <strong>Karaokê Cogumelo</strong>
            <span className="muted small">Escolhe a música e solta a voz no telão</span>
          </div>
        </div>
        <label className="field">
          <span>Como a gente te chama?</span>
          <input
            placeholder="Seu nome ou apelido"
            maxLength={40}
            autoComplete="given-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </label>
        {err && <p className="error" role="alert">{err}</p>}
        <button className="btn primary block" disabled={busy || !name.trim()}>
          {busy ? 'Entrando…' : 'Bora cantar'}
        </button>
      </form>
    </main>
  );
}

function Room({ me, token }: { me: Singer; token: string }) {
  const { queue, singers, settings, results, ranking, loaded, refresh } = useLive({ selfId: me.id });
  const [gifOpen, setGifOpen] = useState(false);
  const [gifSent, setGifSent] = useState(false);
  const [err, setErr] = useState('');
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t);
  }, []);

  // After a selfie the photo must show up right away, even for someone who came on an earlier night:
  // the public read only lists people from tonight, so their own row may not come with the live data.
  const [ownPhotoAt, setOwnPhotoAt] = useState<string | null | undefined>(undefined);
  const listed = singers[me.id];
  // Same reason: while this person's row is not in the live data, their status (approved, refused)
  // is asked to the server now and then, so a refusal tonight shows without reloading the page.
  const [meNow, setMeNow] = useState<Singer>(me);
  const isListed = !!listed;
  useEffect(() => {
    if (isListed) return;
    let stop = false;
    const t = setInterval(async () => {
      try {
        const d = await get('/api/me', { 'x-singer-token': token });
        if (!stop && d?.singer?.id === me.id) setMeNow((m) => (m.status === d.singer.status && m.name === d.singer.name ? m : { ...m, ...d.singer }));
      } catch {}
    }, 45000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [isListed, me.id, token]);
  const self = listed ?? (ownPhotoAt === undefined ? meNow : { ...meNow, photo_at: ownPhotoAt });
  const playing = queue.find((q) => q.status === 'playing') ?? null;
  const line = queue.filter((q) => q.status === 'waiting' && singers[q.singer_id]?.status === 'approved');
  const entry = queue.find((q) => q.singer_id === me.id) ?? null;
  const ahead = entry?.status === 'waiting' ? line.findIndex((q) => q.id === entry.id) : -1;
  const maxDurationSec = settings?.max_duration_sec ?? 360;
  const open = settings?.queue_open ?? true;
  const contestOn = !!settings?.contest_id;
  const canInteract = self.status === 'approved';
  const rankingOn = !!settings?.ranking_enabled && !contestOn;
  // the 5 faces show while someone sings: in the contest and in the night ranking
  const voteOn = contestOn || rankingOn;
  const myBest = rankingOn ? ranking.find((r) => r.singer_id === me.id) ?? null : null;
  const myPos = myBest ? ranking.indexOf(myBest) + 1 : 0;
  const showReact = !!playing && canInteract && !!settings?.reactions_enabled;
  const showGif = canInteract && !!settings?.gifs_enabled;
  const photosOn = !!settings?.photos_enabled;
  const myPhoto = photoUrl(self, settings);
  const photoOf = (singerId: string) => photoUrl(singers[singerId], settings);

  // rough wait: what is left of the current song + everything ahead + the pauses between songs
  let waitMin: number | null = null;
  if (ahead >= 0) {
    let sec = 0;
    if (playing) {
      const started = playing.started_at ? new Date(playing.started_at).getTime() : now;
      sec += Math.max(0, playing.duration_sec - (now - started) / 1000);
    }
    const gap = settings?.intermission_sec ?? 8;
    for (const q of line.slice(0, ahead)) sec += q.duration_sec + gap;
    waitMin = Math.max(1, Math.round((sec + gap) / 60));
  }

  // phones only play sound after a touch: the first one anywhere on the page wakes the audio up
  useEffect(() => {
    const wake = () => unlockSound();
    window.addEventListener('pointerdown', wake, { passive: true });
    window.addEventListener('keydown', wake);
    return () => {
      window.removeEventListener('pointerdown', wake);
      window.removeEventListener('keydown', wake);
    };
  }, []);

  // buzz + chime when it is this person's turn
  const stage = entry?.status === 'playing' ? 'playing' : ahead === 0 ? 'next' : 'other';
  const prevStage = useRef(stage);
  useEffect(() => {
    if (stage === 'playing' && prevStage.current !== 'playing') turnAlert('now');
    prevStage.current = stage;
  }, [stage]);

  // ...and a first warning about 10 seconds before: when the song of whoever is singing now (plus
  // the countdown on the telão) is about to end. It is a guess from the clock, so a pause or a skip
  // moves it; a skip simply goes straight to the "your turn" alert above.
  const warnedFor = useRef<number | null>(null);
  const paused = !!settings?.paused;
  const gapSec = settings?.intermission_sec ?? 8;
  useEffect(() => {
    if (ahead !== 0 || !playing?.started_at || paused || warnedFor.current === playing.id) return;
    const started = Date.parse(playing.started_at);
    if (!Number.isFinite(started)) return;
    const songSec = Math.min(playing.duration_sec, maxDurationSec + 15);
    const warnAt = started + (gapSec + songSec - 10) * 1000;
    const id = playing.id;
    const check = () => {
      if (Date.now() < warnAt || warnedFor.current === id) return;
      warnedFor.current = id;
      turnAlert('soon');
    };
    check();
    // checked every second instead of one long timer: phones stretch long timers on a locked screen
    const t = setInterval(check, 1000);
    return () => clearInterval(t);
  }, [ahead, playing?.id, playing?.started_at, playing?.duration_sec, paused, gapSec, maxDurationSec]);

  // songs left in reserve: they join the end of the queue after this person's current song
  const [reserves, setReserves] = useState<Reserve[]>([]);
  const loadReserves = useCallback(async () => {
    try {
      const d = await get('/api/queue', { 'x-singer-token': token });
      setReserves(Array.isArray(d.reserves) ? d.reserves : []);
    } catch {}
  }, [token]);
  const maxSongs = settings?.songs_per_person ?? 1;
  // again whenever this person's song in the queue changes (a reserve may have just moved in)
  useEffect(() => {
    void loadReserves();
  }, [loadReserves, entry?.id, maxSongs]);

  const add = useCallback(
    async (song: SearchResult) => {
      await post('/api/queue', song, { 'x-singer-token': token });
      await Promise.all([refresh(), loadReserves()]);
    },
    [token, refresh, loadReserves],
  );

  async function removeReserve(id: number) {
    setErr('');
    try {
      await del(`/api/queue?reserve=${id}`, { 'x-singer-token': token });
    } catch (e) {
      setErr((e as Error).message);
    }
    await loadReserves();
  }
  const canReserve = !!entry && open && self.status !== 'blocked' && 1 + reserves.length < maxSongs;

  // "Trocar a música": the new one takes the place of the old one, same spot in the line
  const [swapping, setSwapping] = useState(false);
  const swap = useCallback(
    async (song: SearchResult) => {
      await put('/api/queue', song, { 'x-singer-token': token });
      setSwapping(false);
      await refresh();
    },
    [token, refresh],
  );
  useEffect(() => {
    if (entry?.status !== 'waiting') setSwapping(false);
  }, [entry?.status]);

  async function removeMine() {
    if (!confirm('Tirar sua música da fila? Você perde o lugar na fila.')) return;
    setErr('');
    try {
      await del('/api/queue', { 'x-singer-token': token });
      await Promise.all([refresh(), loadReserves()]);
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  // The song this person just finished: offers the "figurinha" with the crowd's grade.
  const [lastSong, setLastSong] = useState<{ queueId: number; title: string; at: number; score: number | null; night?: string | null } | null>(null);
  const [stickerOpen, setStickerOpen] = useState(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LAST_SONG_KEY);
      const saved = raw ? JSON.parse(raw) : null;
      // only tonight's song (a few hours)
      if (saved && Date.now() - saved.at < 6 * 3600 * 1000) setLastSong(saved);
    } catch {}
  }, []);
  const singingRef = useRef<{ id: number; title: string } | null>(null);
  useEffect(() => {
    const was = singingRef.current;
    singingRef.current = entry?.status === 'playing' ? { id: entry.id, title: entry.title } : null;
    if (!was || was.id === singingRef.current?.id) return;
    const song = { queueId: was.id, title: was.title, at: Date.now(), score: null as number | null, night: settings?.night_started_at ?? null };
    setLastSong(song);
    try {
      localStorage.setItem(LAST_SONG_KEY, JSON.stringify(song));
    } catch {}
  }, [entry?.id, entry?.status, entry?.title]);
  // the database grades the song a moment after it ends: ask a few times
  useEffect(() => {
    if (!lastSong || lastSong.score != null || !settings?.ranking_enabled) return;
    let stop = false;
    const timers = [1500, 5000, 12000].map((ms) =>
      setTimeout(async () => {
        if (stop) return;
        try {
          const { data } = await browserClient().from('queue').select('score').eq('id', lastSong.queueId).maybeSingle();
          const raw = (data as { score?: number | string | null } | null)?.score;
          if (stop || raw == null || !Number.isFinite(Number(raw))) return;
          const next = { ...lastSong, score: Number(raw) };
          stop = true;
          setLastSong(next);
          try {
            localStorage.setItem(LAST_SONG_KEY, JSON.stringify(next));
          } catch {}
        } catch {}
      }, ms),
    );
    return () => {
      stop = true;
      timers.forEach(clearTimeout);
    };
  }, [lastSong, settings?.ranking_enabled]);
  function forgetLastSong() {
    setLastSong(null);
    try {
      localStorage.removeItem(LAST_SONG_KEY);
    } catch {}
  }

  // Tonight's songs, best first, for the "figurinha da noite". Asked again when a song of this
  // person ends or gets its grade, when the night is reset, and every couple of minutes.
  const [nightSongs, setNightSongs] = useState<NightSong[]>([]);
  const loadNight = useCallback(async () => {
    try {
      const d = await get('/api/my-night', { 'x-singer-token': token });
      if (Array.isArray(d?.songs)) setNightSongs(d.songs);
    } catch {}
  }, [token]);
  useEffect(() => {
    void loadNight();
    const t = setInterval(loadNight, 120000);
    return () => clearInterval(t);
  }, [loadNight, lastSong?.queueId, lastSong?.score, settings?.night_started_at]);
  // the song that just ended may not be in the answer yet: it goes in with what the phone knows
  const songsForSticker: NightSong[] = (() => {
    if (!lastSong || nightSongs.some((n) => n.id === lastSong.queueId)) return nightSongs;
    const extra: NightSong = { id: lastSong.queueId, title: lastSong.title, score: lastSong.score, votes: 0, reactions: 0 };
    return [...nightSongs, extra].sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.reactions - a.reactions || b.id - a.id);
  })();

  // a song from the suggestions at the end of the page goes to the search that is on screen
  const [preset, setPreset] = useState<{ text: string; n: number } | null>(null);
  const searchOnScreen = self.status !== 'blocked' && ((!entry && open) || canReserve);

  // "Zerar a noite": last night's grade card and the selfie this phone remembers go away (the
  // selfie itself was deleted on the server), without waiting for the page to be reloaded.
  const nightAt = settings?.night_started_at ? Date.parse(settings.night_started_at) : 0;
  useEffect(() => {
    if (!nightAt || !Number.isFinite(nightAt)) return;
    // the night it was sung (compared as text: the phone's clock may be off), or its time for older cards
    const oldNight = lastSong?.night ? lastSong.night !== settings?.night_started_at : !!lastSong && lastSong.at < nightAt;
    if (oldNight) forgetLastSong();
    if (oldNight) setNightSongs([]);
    if (ownPhotoAt && Date.parse(ownPhotoAt) < nightAt) setOwnPhotoAt(null);
  }, [nightAt, lastSong, ownPhotoAt]);

  if (!loaded) return <Loading />;

  return (
    <main className="phone">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">🍄</span>
          <strong>Karaokê Cogumelo</strong>
        </div>
        <span className="chip with-avatar">
          <Avatar src={myPhoto} seed={me.id} size={22} />
          {self.name}
        </span>
      </header>

      {self.status === 'blocked' && (
        <p className="banner danger">Poxa, o admin não liberou você pra cantar hoje.</p>
      )}
      {self.status === 'pending' && (
        <p className="banner warn">
          Só um instante: o admin já vai liberar sua entrada. {entry ? 'Sua música entra na fila assim que ele aprovar.' : 'Enquanto isso, já vai escolhendo a música.'}
        </p>
      )}
      {err && <p className="error" role="alert">{err}</p>}

      {/* 1. Sua música e a busca: o principal da tela */}
      {self.status !== 'blocked' && entry && (
        <section className={`card mysong ${stage}`}>
          <span className="label">
            {entry.status === 'playing' ? 'Você tá no palco' : self.status === 'pending' ? 'Sua música' : 'Sua música tá na fila'}
          </span>
          <div className="mysong-row">
            {entry.thumbnail && <img src={entry.thumbnail} alt="" width={112} height={63} />}
            <strong>{entry.title}</strong>
          </div>
          {entry.status === 'playing' ? (
            <p className="big-msg">É a sua vez! Pega o microfone e arrasa 🎤</p>
          ) : self.status === 'pending' ? null : ahead === 0 ? (
            <p className="big-msg">Você é o próximo! Vai aquecendo a voz 🔥</p>
          ) : ahead > 0 ? (
            <div className="stats">
              <div>
                <strong>{ahead}</strong>
                <span className="muted small">{ahead === 1 ? 'pessoa na sua frente' : 'pessoas na sua frente'}</span>
              </div>
              {waitMin !== null && (
                <div>
                  <strong>~{waitMin} min</strong>
                  <span className="muted small">de espera</span>
                </div>
              )}
            </div>
          ) : null}
          {entry.status === 'waiting' && self.status === 'approved' && (
            <div className="alert-tip">
              <span className="muted small">📳🔔 O celular vibra e toca um sininho uns 10 s antes da sua vez e de novo na hora. Deixa essa tela aberta.</span>
              <button
                className="btn ghost small"
                onClick={() => {
                  unlockSound();
                  turnAlert('soon');
                }}
              >
                Testar o som
              </button>
            </div>
          )}
          {entry.status === 'waiting' && !swapping && (
            <div className="btns">
              <button className="btn ghost" onClick={() => setSwapping(true)}>
                Trocar a música
              </button>
              <button className="btn ghost" onClick={removeMine}>
                Tirar da fila
              </button>
            </div>
          )}
          {entry.status === 'waiting' && swapping && (
            <>
              <p className="muted small">Escolhe a nova música. Você continua no mesmo lugar da fila.</p>
              <SongSearch authHeaders={{ 'x-singer-token': token }} maxDurationSec={maxDurationSec} pickLabel="Trocar" onPick={swap} />
              <button className="btn ghost self-start" onClick={() => setSwapping(false)}>
                Deixa como tá
              </button>
            </>
          )}
        </section>
      )}

      {self.status !== 'blocked' && reserves.length > 0 && (
        <section className="card">
          <span className="label">{reserves.length === 1 ? 'Sua próxima música' : 'Suas próximas músicas'}</span>
          <ul className="rows">
            {reserves.map((r) => (
              <li key={r.id}>
                <div className="grow">
                  <strong>{r.title}</strong>
                </div>
                <button className="btn small icon-only danger" aria-label={`Tirar ${r.title}`} onClick={() => removeReserve(r.id)}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
          <span className="muted small">Entra no fim da fila depois que você cantar a de agora.</span>
        </section>
      )}

      {canReserve && (
        <section className="card next-song">
          <h2 className="next-song-title">➕ Bora escolher a próxima?</h2>
          <p className="next-song-sub">
            Dá pra deixar mais {maxSongs - 1 - reserves.length === 1 ? 'uma música guardada' : `${maxSongs - 1 - reserves.length} músicas guardadas`}. Ela entra no fim da fila
            depois que você cantar.
          </p>
          <SongSearch authHeaders={{ 'x-singer-token': token }} maxDurationSec={maxDurationSec} pickLabel="Guardar" onPick={add} preset={preset} />
        </section>
      )}

      {self.status !== 'blocked' && !entry && !open && (
        <p className="banner">A fila fechou por hoje. Valeu por cantar com a gente!</p>
      )}

      {self.status !== 'blocked' && !entry && open && (
        <section>
          <SongSearch
            authHeaders={{ 'x-singer-token': token }}
            maxDurationSec={maxDurationSec}
            pickLabel="Cantar"
            onPick={add}
            showPopular
            preset={preset}
          />
          <p className="muted small hint">
            Versão karaokê, de até {Math.floor(maxDurationSec / 60)} minutos. Uma música por vez, pra todo mundo cantar.
          </p>
        </section>
      )}

      {/* 2. A fila */}
      {(playing || line.length > 0) && (
        <section className="card">
          <span className="label">A fila agora</span>
          <ol className="line">
            {playing && (
              <li className={playing.singer_id === me.id ? 'me' : ''}>
                <span className="pos live">♪</span>
                <Avatar src={photoOf(playing.singer_id)} seed={playing.singer_id} size={34} />
                <div className="grow">
                  <strong>{singers[playing.singer_id]?.name ?? '…'}</strong>
                  <span className="muted small">{playing.title}</span>
                </div>
              </li>
            )}
            {line.slice(0, 15).map((q, i) => (
              <li key={q.id} className={q.singer_id === me.id ? 'me' : ''}>
                <span className="pos">{i + 1}</span>
                <Avatar src={photoOf(q.singer_id)} seed={q.singer_id} size={34} />
                <div className="grow">
                  <strong>{singers[q.singer_id]?.name ?? '…'}</strong>
                  <span className="muted small">{q.title}</span>
                </div>
              </li>
            ))}
          </ol>
          {line.length > 15 && <span className="muted small">e mais {line.length - 15} na fila</span>}
        </section>
      )}

      {/* 3. Nota, ranking, figurinha e selfie */}
      {voteOn && playing && playing.singer_id === me.id && (
        <section className={`card ${contestOn ? 'contest' : 'night-vote'}`}>
          <span className="label">{contestOn ? '🏆 Campeonato valendo' : '⭐ Valendo nota'}</span>
          <p>A galera tá dando nota pra você agora. Capricha!</p>
        </section>
      )}
      {voteOn && playing && playing.singer_id !== me.id && canInteract && (
        <VoteCard
          token={token}
          playing={playing}
          contest={contestOn}
          performer={singers[playing.singer_id]?.name ?? 'quem tá cantando'}
        />
      )}
      {contestOn && !playing && (
        <p className="banner contest-banner">🏆 Campeonato valendo! Dá sua nota pra cada um enquanto canta.</p>
      )}

      {lastSong && entry?.status !== 'playing' && (
        <section className="card sticker-ready">
          <span className="label">🎉 Mandou bem!</span>
          <p>
            {lastSong.score != null
              ? `A galera te deu ${fmtScore(lastSong.score)}. ${scorePhrase(lastSong.score)}`
              : 'Sua figurinha da noite já tá com essa música.'}
          </p>
          <div className="btns">
            <button
              className="btn primary"
              onClick={() => setStickerOpen(true)}
            >
              Ver minha figurinha
            </button>
            <button className="btn ghost" onClick={forgetLastSong}>
              Agora não
            </button>
          </div>
        </section>
      )}

      {results && (
        <section className="card contest">
          <span className="label">🏆 Resultado do campeonato</span>
          {results[0]?.score != null && (
            <p className="big-msg">
              {results[0].name} levou a melhor! 🎉
            </p>
          )}
          <Ranking rows={results} limit={10} highlightFirst />
        </section>
      )}

      {rankingOn && (
        <section className="card">
          <span className="label">⭐ Ranking da noite</span>
          {myBest?.score != null && (
            <p className="big-msg">
              Sua nota: {fmtScore(myBest.score)} · {myPos}º lugar. {scorePhrase(myBest.score)}
            </p>
          )}
          <Ranking
            rows={ranking}
            limit={5}
            highlightFirst
            mine={(r) => r.singer_id === me.id}
            photo={(r) => (r.singer_id ? photoOf(r.singer_id) : null)}
            empty="Ninguém pontuou ainda. Enquanto alguém canta, aparecem 5 carinhas aqui pra você dar a nota."
          />
          {myBest?.score != null && songsForSticker.length > 0 && (
            <button className="btn" onClick={() => setStickerOpen(true)}>
              Ver minha figurinha da noite
            </button>
          )}
          {ranking.length > 0 && <span className="muted small">A nota é a média das carinhas que a galera escolhe enquanto você canta.</span>}
        </section>
      )}

      {photosOn && self.status !== 'blocked' && <SelfieCard
          token={token}
          photo={myPhoto}
          onChange={async (photoAt) => {
            setOwnPhotoAt(photoAt);
            await refresh();
          }}
        />}

      {/* 4. Figurinha da noite e sugestões: o fim da tela */}
      {self.status !== 'blocked' && (
        <NightStickerCard songs={songsForSticker} singing={entry?.status === 'playing'} onOpen={() => setStickerOpen(true)} />
      )}

      {searchOnScreen && (
        <Suggestions onPick={(text) => setPreset((p) => ({ text, n: (p?.n ?? 0) + 1 }))} />
      )}

      {(showReact || showGif) && (
        <ReactionBar token={token} reactions={showReact} gifs={showGif} gifSent={gifSent} onGif={() => (setGifSent(false), setGifOpen(true))} />
      )}
      {gifOpen && showGif && (
        <GifSheet
          token={token}
          onClose={() => setGifOpen(false)}
          onSent={() => {
            setGifOpen(false);
            setGifSent(true);
            setTimeout(() => setGifSent(false), 2500);
          }}
        />
      )}
      {stickerOpen && songsForSticker.length > 0 && (
        <StickerSheet name={self.name} photo={myPhoto} songs={songsForSticker} onClose={() => setStickerOpen(false)} />
      )}
    </main>
  );
}

/** Optional selfie: shows on the projector next to the name, in the queue and in the ranking. */
function SelfieCard({ token, photo, onChange }: { token: string; photo: string | null; onChange: (photoAt: string | null) => Promise<void> }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [skipped, setSkipped] = useState(true);
  useEffect(() => {
    try {
      setSkipped(localStorage.getItem(SELFIE_SKIP_KEY) === '1');
    } catch {
      setSkipped(false);
    }
  }, []);

  async function upload(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setErr('');
    try {
      const jpeg = await selfieJpeg(file);
      const d = await post('/api/photo', { jpeg }, { 'x-singer-token': token });
      await onChange(typeof d?.photoAt === 'string' ? d.photoAt : new Date().toISOString());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }
  async function remove() {
    setBusy(true);
    setErr('');
    try {
      await del('/api/photo', { 'x-singer-token': token });
      await onChange(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // no photo and the person said "no thanks" before: stay out of the way
  if (!photo && skipped) return null;
  return (
    <section className="card selfie-card">
      {photo ? <Avatar src={photo} size={64} className="ring" /> : <span className="selfie-ph" aria-hidden="true">📸</span>}
      <div className="grow">
        <strong>{photo ? 'Sua foto tá no telão' : 'Quer aparecer no telão?'}</strong>
        <p className="muted small">
          {photo
            ? 'Aparece do lado do seu nome, na fila e no ranking. Some no fim da noite.'
            : 'Tira uma selfie (opcional). Ela aparece no telão, na fila e no ranking, e some no fim da noite. Foto de criança só com o ok de um responsável.'}
        </p>
        <input ref={input} type="file" accept="image/*" capture="user" hidden onChange={(e) => upload(e.target.files?.[0])} />
        <div className="btns">
          <button className="btn primary small" disabled={busy} onClick={() => input.current?.click()}>
            {busy ? <span className="spinner" /> : photo ? 'Tirar outra' : 'Tirar selfie'}
          </button>
          {photo ? (
            <button className="btn ghost small" disabled={busy} onClick={remove}>
              Apagar minha foto
            </button>
          ) : (
            <button
              className="btn ghost small"
              onClick={() => {
                setSkipped(true);
                try {
                  localStorage.setItem(SELFIE_SKIP_KEY, '1');
                } catch {}
              }}
            >
              Sem foto
            </button>
          )}
        </div>
        {err && <p className="error" role="alert">{err}</p>}
      </div>
    </section>
  );
}

/** Theme of the sticker, remembered on this phone. */
function useStickerTheme(): [number, () => void] {
  const [theme, setTheme] = useState(0);
  useEffect(() => {
    try {
      const n = Number(localStorage.getItem(THEME_KEY));
      if (Number.isInteger(n) && n >= 0 && n < STICKER_THEMES.length) setTheme(n);
    } catch {}
  }, []);
  const next = () =>
    setTheme((t) => {
      const n = (t + 1) % STICKER_THEMES.length;
      try {
        localStorage.setItem(THEME_KEY, String(n));
      } catch {}
      return n;
    });
  return [theme, next];
}

/** End of the page: the night's sticker so far (top 3), updating itself as the person sings. */
function NightStickerCard({ songs, singing, onOpen }: { songs: NightSong[]; singing: boolean; onOpen: () => void }) {
  const top = songs.slice(0, 3);
  return (
    <section className="card night-sticker">
      <span className="label">🌟 Sua figurinha da noite</span>
      {top.length === 0 ? (
        <p className="muted small">
          {singing
            ? 'Canta com vontade: quando acabar, essa música entra aqui na sua figurinha.'
            : 'Canta uma e ela aparece aqui: "Estive no Cogumelo Bar e cantei...", com suas 3 melhores da noite. Atualiza sozinha!'}
        </p>
      ) : (
        <>
          <strong className="night-head">{nightHeadline(songs)}</strong>
          <ol className="night-top">
            {top.map((s, i) => (
              <li key={s.id}>
                <span className="medal" aria-hidden="true">
                  {top.length > 1 ? ['🥇', '🥈', '🥉'][i] : '🎤'}
                </span>
                <span className="grow">{cleanSongTitle(s.title)}</span>
                {s.score != null ? (
                  <b>{fmtScore(s.score)}</b>
                ) : s.reactions > 0 ? (
                  <span className="muted small">🔥 {s.reactions}</span>
                ) : null}
              </li>
            ))}
          </ol>
          {songs.length > 3 && <span className="muted small">e mais {songs.length - 3} na conta. Ficam as 3 melhores pela nota e pelas reações.</span>}
          <button className="btn primary" onClick={onOpen}>
            Ver e compartilhar
          </button>
        </>
      )}
    </section>
  );
}

/** "Figurinha da noite": the image with the 3 best songs, to share. Redrawn when the songs change. */
function StickerSheet({ name, photo, songs, onClose }: { name: string; photo: string | null; songs: NightSong[]; onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [theme, nextTheme] = useStickerTheme();
  // redraw only when something on the image changes
  const key = JSON.stringify([name, photo, theme, songs.slice(0, 3).map((s) => [s.id, s.score, s.reactions, s.title]), songs.length]);
  useEffect(() => {
    let stop = false;
    let made: string | null = null;
    drawNightSticker({ name, photo, songs, theme })
      .then((blob) => {
        if (stop) return;
        const slug = name.normalize('NFD').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30).toLowerCase();
        setFile(new File([blob], `cogumelo-${slug || 'karaoke'}.png`, { type: 'image/png' }));
        made = URL.createObjectURL(blob);
        setUrl(made);
        setErr('');
      })
      .catch((e) => !stop && setErr((e as Error).message));
    return () => {
      stop = true;
      if (made) URL.revokeObjectURL(made);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const canShare = !!file && typeof navigator !== 'undefined' && !!navigator.canShare?.({ files: [file] });
  async function share() {
    if (!file) return;
    const first = cleanSongTitle(songs[0]?.title ?? '');
    try {
      await navigator.share({ files: [file], text: `Estive no Cogumelo Bar e cantei ${first ? `"${first}"` : 'no karaokê'}! 🎤🍄` });
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setErr('Não deu pra compartilhar. Usa o botão de salvar.');
    }
  }

  return (
    <div className="sheet-back" onClick={onClose}>
      <div className="sheet sticker-sheet" role="dialog" aria-label="Sua figurinha" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <strong>Sua figurinha da noite</strong>
          <button className="btn small icon-only ghost" aria-label="Fechar" onClick={onClose}>
            ✕
          </button>
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {url ? <img className="sticker-img" src={url} alt="Figurinha com seu nome e suas melhores músicas da noite" /> : !err && <span className="spinner big" />}
        {err && <p className="error" role="alert">{err}</p>}
        <div className="btns">
          {canShare && (
            <button className="btn primary" onClick={share}>
              Compartilhar
            </button>
          )}
          {url && file && (
            <a className={`btn${canShare ? '' : ' primary'}`} href={url} download={file.name}>
              Salvar imagem
            </a>
          )}
          <button className="btn ghost" onClick={nextTheme}>
            🎨 Trocar a cor
          </button>
        </div>
        <span className="muted small">Ela se atualiza sozinha a cada música que você canta hoje. Posta no story e marca o Cogumelo! 🍄</span>
      </div>
    </div>
  );
}

/** Last thing on the page: song ideas by style. A tap fills in the search with that song. */
function Suggestions({ onPick }: { onPick: (text: string) => void }) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const cat = SUGGESTIONS.find((c) => c.key === openKey) ?? null;
  return (
    <section className="card suggestions">
      <span className="label">💡 Sem ideia do que cantar?</span>
      <div className="cat-chips" role="tablist" aria-label="Estilos">
        {SUGGESTIONS.map((c) => (
          <button
            key={c.key}
            role="tab"
            aria-selected={openKey === c.key}
            className={`cat-chip${openKey === c.key ? ' on' : ''}`}
            onClick={() => setOpenKey((k) => (k === c.key ? null : c.key))}
          >
            <span aria-hidden="true">{c.emoji}</span> {c.name}
          </button>
        ))}
      </div>
      {cat ? (
        <>
          <span className="muted small">{cat.blurb}</span>
          <ul className="rows sugg-list">
            {cat.songs.map((s) => (
              <li key={`${s.title}-${s.artist}`}>
                <div className="grow">
                  <strong>{s.title}</strong>
                  <span className="muted small">{s.artist}</span>
                </div>
                <button className="btn small" onClick={() => onPick(`${s.title} ${s.artist}`)}>
                  Achar
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <span className="muted small">Toca num estilo pra ver umas ideias. Ao escolher, a gente já procura o karaokê lá em cima.</span>
      )}
    </section>
  );
}

/**
 * Five faces, from "off key" to "nailed it", for whoever is singing. Used by the contest and by the
 * night ranking (there the grade is the average of the faces, on a 0 to 10 scale). The vote can be
 * changed until the song ends.
 */
function VoteCard({ token, playing, performer, contest }: { token: string; playing: QueueItem; performer: string; contest: boolean }) {
  const [vote, setVote] = useState<number | null>(null);
  const [err, setErr] = useState('');

  // a new song starts with no vote; ask the server in case this phone already voted (page reload)
  useEffect(() => {
    setVote(null);
    setErr('');
    let stop = false;
    get('/api/vote', { 'x-singer-token': token })
      .then((d) => {
        if (!stop && d.queueId === playing.id && d.score) setVote((v) => v ?? d.score);
      })
      .catch(() => {});
    return () => {
      stop = true;
    };
  }, [playing.id, token]);

  async function cast(score: number) {
    const prev = vote;
    setVote(score);
    setErr('');
    try {
      navigator.vibrate?.(15);
    } catch {}
    try {
      await post('/api/vote', { score }, { 'x-singer-token': token });
    } catch (e) {
      setVote(prev);
      setErr((e as Error).message);
    }
  }

  return (
    <section className={`card ${contest ? 'contest' : 'night-vote'}`}>
      <span className="label">{contest ? '🏆 Campeonato · sua nota' : '⭐ Ranking da noite · sua nota'}</span>
      <p>
        E aí, o que você tá achando de <strong>{performer}</strong>?
      </p>
      <div className="votes" role="radiogroup" aria-label={`Nota para ${performer}`}>
        {SCORE_EMOJIS.map((emoji, i) => (
          <button
            key={i}
            role="radio"
            aria-checked={vote === i + 1}
            aria-label={SCORE_LABELS[i]}
            className={vote === i + 1 ? 'on' : ''}
            onClick={() => cast(i + 1)}
          >
            {emoji}
          </button>
        ))}
      </div>
      {err ? (
        <p className="error" role="alert">{err}</p>
      ) : (
        <p className="muted small">{vote ? `${SCORE_LABELS[vote - 1]}! Dá pra mudar até a música acabar.` : 'Toca numa carinha. A votação fecha quando a música acabar.'}</p>
      )}
    </section>
  );
}

/** Quick reactions that float on the projector while someone sings. */
function ReactionBar({ token, reactions, gifs, gifSent, onGif }: { token: string; reactions: boolean; gifs: boolean; gifSent: boolean; onGif: () => void }) {
  const lastAt = useRef(0);
  const [pops, setPops] = useState<{ id: number; i: number }[]>([]);
  const [msg, setMsg] = useState('');

  function send(i: number) {
    const now = Date.now();
    if (now - lastAt.current < 450) return; // one tap at a time
    lastAt.current = now;
    setPops((p) => [...p.slice(-6), { id: now, i }]);
    setTimeout(() => setPops((p) => p.filter((x) => x.id !== now)), 900);
    try {
      navigator.vibrate?.(12);
    } catch {}
    post('/api/react', { emoji: REACTIONS[i].key }, { 'x-singer-token': token }).catch((e) => {
      setMsg((e as Error).message);
      setTimeout(() => setMsg(''), 2500);
    });
  }

  return (
    <div className="reactbar" aria-label="Mandar reação pro telão">
      {(msg || gifSent) && <span className="reactbar-msg">{msg || 'Foi pro telão! 🎉'}</span>}
      {gifs && (
        <button className="gif-btn" aria-label="Mandar GIF ou figurinha pro telão" onClick={onGif}>
          GIF
        </button>
      )}
      {reactions && REACTIONS.map((r, i) => (
        <button key={r.key} aria-label={r.label} onClick={() => send(i)}>
          {r.emoji}
          {pops
            .filter((p) => p.i === i)
            .map((p) => (
              <span key={p.id} className="pop" aria-hidden="true">
                {r.emoji}
              </span>
            ))}
        </button>
      ))}
    </div>
  );
}

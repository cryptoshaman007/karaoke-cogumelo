'use client';
import { useEffect, useRef, useState } from 'react';
import QRCode from 'react-qr-code';
import AdminLogin from '@/components/AdminLogin';
import { useAdmin } from '@/lib/useAdmin';
import Icon from '@/components/Icon';
import { post, useLive, type ApiError } from '@/lib/useLive';
import { browserClient } from '@/lib/supabase-browser';
import { fmtScore, REACTIONS, type QueueItem, type Settings } from '@/lib/types';

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    YT: any;
    onYouTubeIframeAPIReady: () => void;
  }
}

const YT_API = 'https://www.youtube.com/iframe_api';

/** Loads the YouTube player script. Keeps trying if the internet is down at that moment. */
function loadYT(): Promise<any> {
  return new Promise((resolve) => {
    if (window.YT?.Player) return resolve(window.YT);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearInterval(poll);
      resolve(window.YT);
    };
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      finish();
    };
    const inject = () => {
      if (done) return;
      document.getElementById('yt-api')?.remove();
      // a half-loaded API would refuse to load again
      if (window.YT && !window.YT.Player) window.YT = undefined;
      const s = document.createElement('script');
      s.id = 'yt-api';
      s.src = YT_API;
      s.onerror = () => setTimeout(inject, 4000);
      document.head.appendChild(s);
    };
    let waited = 0;
    const poll = setInterval(() => {
      if (window.YT?.Player) return finish();
      waited += 1;
      if (waited % 20 === 0) inject(); // loaded nothing in 20 s: start over
    }, 1000);
    inject();
  });
}

// Where the current song was, so reloading the page (or a power cut) resumes instead of restarting.
const PROGRESS_KEY = 'karaoke_progress';
function readProgress(): { id: number; t: number } | null {
  try {
    return JSON.parse(localStorage.getItem(PROGRESS_KEY) ?? 'null');
  } catch {
    return null;
  }
}
function writeProgress(p: { id: number; t: number } | null) {
  try {
    if (p) localStorage.setItem(PROGRESS_KEY, JSON.stringify(p));
    else localStorage.removeItem(PROGRESS_KEY);
  } catch {}
}

/** The video waits while the admin paused it or while contest results are on screen. */
const onHold = (s: Settings | null) => !!s && (s.paused || s.results_contest_id != null);

const isOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false;

// Watchdog timings (ms). The video is checked every TICK.
const TICK = 3000;
const RESUME_PAUSED_AFTER = 6000; // paused by a stray click on the video: play again
const RELOAD_STALLED_AFTER = 30000; // was playing and froze: load it again at the same point
// A video that never starts may just be showing an ad (the song's clock stays at zero meanwhile),
// so these are generous: load it again a couple of times before giving up on it.
const RELOAD_UNSTARTED_EVERY = 75000;
const SKIP_UNSTARTED_AFTER = 240000;
const MAX_DEAD_SKIPS = 2; // in a row. After that the problem is not the videos: stop skipping
const PLAYER_READY_TIMEOUT = 20000;

// Survives the screen being rebuilt after an error (same page, sound already allowed).
let startedOnce = false;

// Remembers that this computer already started the karaoke, so a reload (Chrome restarting,
// power cut, Windows update) starts again by itself instead of waiting for a click nobody gives.
const STARTED_KEY = 'karaoke_started';
function wasStarted() {
  try {
    return localStorage.getItem(STARTED_KEY) === '1';
  } catch {
    return false;
  }
}
function markStarted() {
  try {
    localStorage.setItem(STARTED_KEY, '1');
  } catch {}
}
// After a reload without a click, Chrome may refuse to play with sound. Then the video plays muted
// (better than a stopped queue) and the screen asks for one click to turn the sound on.
const SOUND_CHECK_AFTER = 5000;
const hasUserClicked = () => (navigator as any).userActivation?.hasBeenActive === true;

export default function TvPage() {
  const [admin, setAdmin] = useAdmin();
  if (admin === null)
    return (
      <main className="center">
        <span className="spinner big" aria-label="Carregando" />
      </main>
    );
  if (!admin) return <AdminLogin title="Tela do projetor" onOk={() => setAdmin(true)} />;
  return <Tv onLogout={() => setAdmin(false)} />;
}

function Tv({ onLogout }: { onLogout: () => void }) {
  const { queue, singers, settings, results, loaded, refresh } = useLive({ tv: true });
  const [started, setStarted] = useState(startedOnce);
  const [muted, setMuted] = useState(false); // playing without sound: waiting for a click
  const [showSettings, setShowSettings] = useState(false);
  const [origin, setOrigin] = useState('');
  const [intro, setIntro] = useState<{ id: number; left: number } | null>(null);
  const [notice, setNotice] = useState('');
  const [floaters, setFloaters] = useState<{ id: number; emoji: string; x: number; size: number; dur: number }[]>([]);

  const holderRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<any>(null);
  const playerReady = useRef(false);
  const loadedVideo = useRef<number | null>(null); // queue id the player is on (or counting down to)
  const videoStarted = useRef(false); // false while the "next singer" countdown runs
  const advancing = useRef(false);
  // an "end of song" the server did not confirm yet (e.g. the internet blinked): retried until it goes through
  const pending = useRef<{ id: number; endStatus: 'done' | 'skipped' } | null>(null);
  // health of the video on screen, for the watchdog
  const health = useRef({ everPlayed: false, lastTime: 0, stalledMs: 0, reloads: 0, errors: 0 });
  const deadSkips = useRef(0);
  const introTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const soundTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mutedRef = useRef(false);

  useEffect(() => {
    setOrigin(window.location.origin);
    if (wasStarted()) setStarted(true);
  }, []);

  /** The browser blocked sound: play muted and ask for a click. */
  function goMuted() {
    const p = playerRef.current;
    if (!p) return;
    p.mute?.();
    p.playVideo?.();
    mutedRef.current = true;
    setMuted(true);
  }

  /** One click anywhere on the screen after a muted start: sound back on. */
  function unmute() {
    const p = playerRef.current;
    mutedRef.current = false;
    setMuted(false);
    if (!p) return;
    p.unMute?.();
    p.setVolume?.(settingsRef.current?.volume ?? 100);
    if (!onHold(settingsRef.current) && p.getPlayerState?.() !== 1) p.playVideo?.();
  }

  const playing = queue.find((q) => q.status === 'playing') ?? null;
  const waiting = queue.filter((q) => q.status === 'waiting' && singers[q.singer_id]?.status === 'approved');
  const pendingCount = queue.filter((q) => q.status === 'waiting' && singers[q.singer_id]?.status === 'pending').length;

  // refs so the YouTube callbacks and timers always see the latest values
  const playingRef = useRef<QueueItem | null>(playing);
  playingRef.current = playing;
  const waitingRef = useRef(waiting.length);
  waitingRef.current = waiting.length;
  const settingsRef = useRef<Settings | null>(settings);
  settingsRef.current = settings;
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;

  /** Message over the video. `sticky` stays until something else replaces or clears it. */
  function flash(msg: string, sticky = false) {
    setNotice(msg);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = sticky || !msg ? null : setTimeout(() => setNotice(''), 6000);
  }

  /**
   * Asks the server to move the queue. `id` is the song this screen believes is playing (the
   * server ignores the request if it is another one). Returns true when the server answered.
   */
  async function advance(endStatus: 'done' | 'skipped', id: number | null, retry = true): Promise<boolean> {
    if (retry && id != null) pending.current = { id, endStatus };
    if (advancing.current) return false;
    advancing.current = true;
    try {
      await post('/api/player', { current: id, endStatus });
      if (pending.current?.id === id) pending.current = null;
      void refresh();
      return true;
    } catch (e) {
      console.error(e);
      // logged out (password changed, cookies cleared): without this the queue would stop silently
      if ((e as ApiError).status === 401) onLogout();
      return false;
    } finally {
      setTimeout(() => (advancing.current = false), 1000);
    }
  }

  // The skip button on this screen. Hammering it skips one song, not several: after a skip it
  // rests for a few seconds (the next singer's countdown is on screen anyway).
  const lastSkip = useRef(0);
  function skipNow() {
    const id = playingRef.current?.id ?? null;
    if (id == null || Date.now() - lastSkip.current < 4000) return;
    lastSkip.current = Date.now();
    void advance('skipped', id);
  }

  function clearIntro() {
    if (introTimer.current) clearInterval(introTimer.current);
    introTimer.current = null;
    setIntro(null);
  }

  function startVideo(item: QueueItem, startSeconds: number) {
    const p = playerRef.current;
    if (!p || loadedVideo.current !== item.id) return;
    videoStarted.current = true;
    health.current = { everPlayed: false, lastTime: startSeconds, stalledMs: 0, reloads: 0, errors: 0 };
    p.setVolume?.(settingsRef.current?.volume ?? 100);
    // on hold (paused, or contest results on screen): get it ready without a burst of sound
    if (onHold(settingsRef.current) && p.cueVideoById) p.cueVideoById({ videoId: item.video_id, startSeconds });
    else p.loadVideoById({ videoId: item.video_id, startSeconds });
    if (mutedRef.current) p.mute?.();

    // Started by itself after a reload (nobody clicked yet) and the video did not start: Chrome is
    // holding the sound. Checked before the watchdog could ever count this video as dead.
    if (soundTimer.current) clearTimeout(soundTimer.current);
    soundTimer.current = setTimeout(() => {
      const pl = playerRef.current;
      if (!pl || loadedVideo.current !== item.id || mutedRef.current || hasUserClicked()) return;
      if (onHold(settingsRef.current)) return;
      const st = pl.getPlayerState?.();
      if (st !== 1 && st !== 3) goMuted();
    }, SOUND_CHECK_AFTER);
  }

  /** Loads the current video again, from where it was. Used when it froze or never started. */
  function reloadVideo() {
    const p = playerRef.current;
    const cur = playingRef.current;
    if (!p || !playerReady.current || !cur || !videoStarted.current || loadedVideo.current !== cur.id) return;
    const h = health.current;
    h.reloads += 1;
    p.loadVideoById({ videoId: cur.video_id, startSeconds: h.lastTime > 3 ? Math.floor(h.lastTime) : 0 });
  }

  function syncPlayer() {
    const p = playerRef.current;
    if (!p || !playerReady.current) return;
    const cur = playingRef.current;
    if (!cur) {
      if (loadedVideo.current !== null) {
        p.stopVideo?.();
        loadedVideo.current = null;
        videoStarted.current = false;
        clearIntro();
        writeProgress(null);
      }
      return;
    }
    if (loadedVideo.current === cur.id) return;
    loadedVideo.current = cur.id;
    videoStarted.current = false;
    clearIntro();
    p.stopVideo?.();

    // same song as before a reload: pick up where it was, no countdown
    const saved = readProgress();
    const resumeAt = saved && saved.id === cur.id && saved.t > 5 && saved.t < cur.duration_sec - 5 ? saved.t : 0;
    const wait = resumeAt > 0 ? 0 : settingsRef.current?.intermission_sec ?? 8;
    if (wait <= 0) return startVideo(cur, resumeAt);

    // counts against the clock, so a throttled timer never stretches the countdown
    const endAt = Date.now() + wait * 1000;
    setIntro({ id: cur.id, left: wait });
    introTimer.current = setInterval(() => {
      const left = Math.ceil((endAt - Date.now()) / 1000);
      if (left > 0) return setIntro((i) => (i && i.id === cur.id && i.left === left ? i : { id: cur.id, left }));
      clearIntro();
      startVideo(cur, 0);
    }, 250);
  }

  // create the player once the user has clicked "start" (needed so the browser allows sound)
  useEffect(() => {
    if (!started) return;
    startedOnce = true;
    markStarted();
    let cancelled = false;
    let readyTimer: ReturnType<typeof setTimeout> | undefined;

    const build = (YT: any) => {
      if (cancelled) return;
      const holder = holderRef.current;
      if (!holder) return;
      playerReady.current = false;
      loadedVideo.current = null;
      videoStarted.current = false;
      try {
        playerRef.current?.destroy?.();
      } catch {}
      playerRef.current = null;
      // React never touches what is inside the holder, so the player can be rebuilt at will
      holder.innerHTML = '';
      const el = document.createElement('div');
      holder.appendChild(el);
      try {
        playerRef.current = new YT.Player(el, {
          width: '100%',
          height: '100%',
          playerVars: { autoplay: 1, controls: 0, rel: 0, modestbranding: 1, playsinline: 1, iv_load_policy: 3, fs: 0, disablekb: 1 },
          events: {
            onReady: () => {
              if (cancelled) return;
              playerReady.current = true;
              loadedVideo.current = null;
              flash('');
              syncPlayer();
            },
            onStateChange: (e: any) => {
              // admin paused from the phone while the video was still loading
              if (e.data === YT.PlayerState.PLAYING && onHold(settingsRef.current)) playerRef.current?.pauseVideo?.();
              if (e.data === YT.PlayerState.ENDED && videoStarted.current && loadedVideo.current != null) {
                writeProgress(null);
                void advance('done', loadedVideo.current);
              }
            },
            onError: (e: any) => {
              if (!videoStarted.current || loadedVideo.current == null) return;
              // the internet dropped: not the video's fault. The watchdog loads it again later.
              if (!isOnline()) return;
              const h = health.current;
              h.errors += 1;
              // 2 = invalid id, 100 = removed/private, 101/150 = owner blocked embedding: no point retrying.
              // Anything else (5 = player hiccup) gets one more chance first.
              const fatal = [2, 100, 101, 150].includes(Number(e?.data));
              if (!fatal && h.errors <= 1) return void setTimeout(reloadVideo, 1500);
              flash('Este vídeo não pôde ser tocado. Passando para o próximo.');
              writeProgress(null);
              void advance('skipped', loadedVideo.current);
            },
          },
        });
      } catch (err) {
        console.error('player failed to start', err);
      }
      // the player frame did not load (internet down?): throw it away and build another
      readyTimer = setTimeout(() => {
        if (cancelled || playerReady.current) return;
        flash('Conectando ao YouTube… Confira a internet do computador.', true);
        build(YT);
      }, PLAYER_READY_TIMEOUT);
    };

    loadYT().then(build);
    return () => {
      cancelled = true;
      clearTimeout(readyTimer);
      if (soundTimer.current) clearTimeout(soundTimer.current);
      if (introTimer.current) clearInterval(introTimer.current);
      introTimer.current = null;
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
      try {
        playerRef.current?.destroy?.();
      } catch {}
      playerRef.current = null;
      playerReady.current = false;
      loadedVideo.current = null;
      videoStarted.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started]);

  // react to queue changes
  useEffect(() => {
    if (!started || !loaded) return;
    if (pending.current && pending.current.id !== playing?.id) pending.current = null;
    syncPlayer();
    if (!playing && waiting.length > 0) void advance('done', null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, loaded, playing?.id, waiting.length]);

  // remote control from the admin phone: pause / resume. Contest results on screen also hold the video.
  const hold = onHold(settings);
  useEffect(() => {
    const p = playerRef.current;
    if (!p || !playerReady.current || !videoStarted.current) return;
    if (hold) p.pauseVideo?.();
    else p.playVideo?.();
  }, [hold]);

  // reactions sent from the phones float up over the video
  const reactionsOn = !!settings?.reactions_enabled;
  useEffect(() => {
    if (!reactionsOn) return;
    const sb = browserClient();
    let n = 0;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const ch = sb
      .channel('karaoke-reactions')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'reactions' }, (payload) => {
        const emoji = REACTIONS.find((r) => r.key === (payload.new as { emoji?: string }).emoji)?.emoji;
        if (!emoji) return;
        const id = ++n;
        const dur = 3.2 + Math.random() * 1.6;
        // at most 40 on screen: a burst never slows the projector down
        setFloaters((f) => (f.length >= 40 ? f : [...f, { id, emoji, x: 4 + Math.random() * 88, size: 0.8 + Math.random() * 0.6, dur }]));
        const t = setTimeout(() => {
          timers.delete(t);
          setFloaters((f) => f.filter((x) => x.id !== id));
        }, dur * 1000 + 100);
        timers.add(t);
      })
      .subscribe();
    return () => {
      sb.removeChannel(ch).catch(() => {});
      timers.forEach(clearTimeout);
      setFloaters([]);
    };
  }, [reactionsOn]);

  // remote control: volume
  useEffect(() => {
    if (playerReady.current && settings) playerRef.current?.setVolume?.(settings.volume);
  }, [settings?.volume, settings]);

  // remote control: restart the current song
  const lastRestart = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!settings) return;
    const prev = lastRestart.current;
    lastRestart.current = settings.restart_at;
    if (prev === undefined || prev === settings.restart_at) return; // first load, or nothing new
    const p = playerRef.current;
    if (!p || !playerReady.current || !videoStarted.current) return;
    writeProgress(null);
    health.current.lastTime = 0;
    health.current.stalledMs = 0;
    p.seekTo?.(0, true);
    p.playVideo?.();
  }, [settings?.restart_at, settings]);

  // Watchdog. Every few seconds: save progress, enforce the time limit, and get the karaoke moving
  // again by itself if anything is stuck (lost request, frozen video, video that never started).
  useEffect(() => {
    if (!started) return;
    const t = setInterval(() => {
      if (!loadedRef.current) return;
      const cur = playingRef.current;

      // the server never confirmed the end of this song: ask again
      const pend = pending.current;
      if (pend) {
        if (cur?.id === pend.id) return void advance(pend.endStatus, pend.id);
        pending.current = null;
      }
      if (!cur) {
        // someone is waiting but nothing is playing (e.g. a request was lost): try again
        if (waitingRef.current > 0) void advance('done', null);
        return;
      }
      const p = playerRef.current;
      if (!p?.getCurrentTime || !playerReady.current || !videoStarted.current || loadedVideo.current !== cur.id) return;
      const time = Number(p.getCurrentTime()) || 0;
      const state: number | undefined = p.getPlayerState?.();
      const max = settingsRef.current?.max_duration_sec ?? 360;
      if (time > max + 15) return void advance('done', cur.id);
      // finished, but the "ended" event was lost
      if (state === 0) return void advance('done', cur.id);

      const h = health.current;
      if (state === 1 && Math.abs(time - h.lastTime) > 0.2) {
        // moving: all good
        h.lastTime = time;
        h.stalledMs = 0;
        h.everPlayed = true;
        if (deadSkips.current > 0) flash('');
        deadSkips.current = 0;
        writeProgress({ id: cur.id, t: time });
        return;
      }
      if (onHold(settingsRef.current)) return void (h.stalledMs = 0); // stopped on purpose
      if (!isOnline()) return; // no network at all: wait for it, never punish the singer
      h.stalledMs += TICK;

      if (state === 2) {
        // someone clicked the video and paused it by accident
        if (h.stalledMs >= RESUME_PAUSED_AFTER) p.playVideo?.();
        return;
      }
      if (h.everPlayed) {
        // froze in the middle (internet blinked): load it again at the same point, never skip
        if (h.stalledMs >= RELOAD_STALLED_AFTER) {
          h.stalledMs = 0;
          reloadVideo();
        }
        return;
      }
      // never started
      if (h.stalledMs >= SKIP_UNSTARTED_AFTER) {
        h.stalledMs = 0;
        h.reloads = 0;
        if (deadSkips.current >= MAX_DEAD_SKIPS) {
          // several in a row: the problem is the connection, not the songs. Keep trying this one.
          flash('O vídeo não está carregando. Confira a internet do computador.', true);
          return reloadVideo();
        }
        flash('Este vídeo não carregou. Passando para o próximo.');
        void advance('skipped', cur.id, false).then((ok) => {
          if (ok) deadSkips.current += 1;
          else reloadVideo(); // server unreachable too: it is the internet, give the song another chance
        });
        return;
      }
      if (h.stalledMs >= RELOAD_UNSTARTED_EVERY * (h.reloads + 1)) reloadVideo();
    }, TICK);

    // internet is back: do not wait for the watchdog
    const onOnline = () => {
      const p = playerRef.current;
      if (!p || !videoStarted.current || onHold(settingsRef.current)) return;
      if (p.getPlayerState?.() !== 1) setTimeout(reloadVideo, 1500);
    };
    window.addEventListener('online', onOnline);
    return () => {
      clearInterval(t);
      window.removeEventListener('online', onOnline);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started]);

  // keep the projector PC awake while the karaoke screen is open
  useEffect(() => {
    let lock: { release?: () => Promise<void> } | null = null;
    const request = async () => {
      try {
        lock = (await (navigator as any).wakeLock?.request('screen')) ?? null;
      } catch {}
    };
    request();
    const onVis = () => document.visibilityState === 'visible' && request();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      lock?.release?.().catch(() => {});
    };
  }, []);

  const singUrl = origin ? `${origin}/cantar` : '';
  const adminUrl = origin ? `${origin}/admin` : '';
  const nowName = playing ? singers[playing.singer_id]?.name ?? '' : '';
  const open = settings?.queue_open ?? true;
  const showVideo = !!playing && !intro;
  const winner = results?.[0]?.score != null ? results[0] : null;
  const SHOWN = 8;

  return (
    <main className="tv">
      <section className="stage">
        <div className={showVideo ? 'player-wrap' : 'player-wrap hidden'}>
          <div className="yt-holder" ref={holderRef} />
        </div>

        {!playing && (
          <div className="idle">
            <div className="idle-text">
              <span className="eyebrow">🍄 Karaokê Cogumelo</span>
              <h1>{open ? 'Quem canta agora?' : 'Por hoje é só!'}</h1>
              {open ? (
                <ol className="steps">
                  <li>Aponte a câmera do celular para o QR code</li>
                  <li>Digite seu nome</li>
                  <li>Escolha a música e espere sua vez</li>
                </ol>
              ) : (
                <p>A fila está fechada. Obrigado por cantar com a gente!</p>
              )}
            </div>
            {open && singUrl && (
              <div className="qr big">
                <QRCode value={singUrl} size={320} />
              </div>
            )}
          </div>
        )}

        {playing && intro && (
          <div className="intro">
            <span className="eyebrow">Agora é a vez de</span>
            <h1>{nowName}</h1>
            <p>{playing.title}</p>
            <span className="count" key={intro.left}>
              {intro.left}
            </span>
          </div>
        )}

        {showVideo && settings?.paused && !results && <div className="badge-paused">Pausado</div>}

        {floaters.length > 0 && (
          <div className="floaters" aria-hidden="true">
            {floaters.map((f) => (
              <span key={f.id} style={{ left: `${f.x}%`, fontSize: `${f.size * 4.2}vw`, animationDuration: `${f.dur}s` }}>
                {f.emoji}
              </span>
            ))}
          </div>
        )}

        {results && (
          <div className="results-screen">
            <span className="eyebrow">🏆 Resultado do campeonato</span>
            {winner ? (
              <>
                <h1>{winner.name}</h1>
                <p>
                  {winner.title} · nota {fmtScore(winner.score)} ({winner.votes === 1 ? '1 voto' : `${winner.votes} votos`})
                </p>
              </>
            ) : (
              <h1 className="smaller">Sem votos desta vez</h1>
            )}
            {results.length > 1 && (
              <ol>
                {results.slice(winner ? 1 : 0, 8).map((r, i) => (
                  <li key={r.queue_id}>
                    <span className="pos">{i + (winner ? 2 : 1)}</span>
                    <strong>{r.name}</strong>
                    <span className="song">{r.title}</span>
                    <span className="pts">{fmtScore(r.score)}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
        {notice && <div className="toast">{notice}</div>}

        {started && muted && (
          <button className="sound-overlay" onClick={unmute}>
            <span>🔇 Clique na tela para ligar o som</span>
          </button>
        )}

        {!started && (
          <button className="start-overlay" onClick={() => setStarted(true)}>
            <span className="start-btn">
              <Icon name="play" size={40} />
            </span>
            Clique para iniciar o karaokê
            <small>Necessário para o navegador liberar o som</small>
          </button>
        )}
      </section>

      <aside className="side">
        <div className="now">
          <span className="label">Cantando agora</span>
          <strong>{playing ? nowName : '—'}</strong>
          {playing && <span className="song">{playing.title}</span>}
        </div>

        <div className="list">
          <span className="label">Próximos {waiting.length > 0 && `· ${waiting.length}`}</span>
          {waiting.length === 0 ? (
            <p className="muted">{open ? 'Fila vazia. Bora cantar?' : 'Fila encerrada.'}</p>
          ) : (
            <ol>
              {waiting.slice(0, SHOWN).map((q, i) => (
                <li key={q.id}>
                  <span className="pos">{i + 1}</span>
                  <div>
                    <strong>{singers[q.singer_id]?.name}</strong>
                    <span>{q.title}</span>
                  </div>
                </li>
              ))}
            </ol>
          )}
          {waiting.length > SHOWN && <p className="muted more">+ {waiting.length - SHOWN} na fila</p>}
        </div>

        {settings?.contest_id && (
          <div className="tv-message contest-on">
            🏆 Campeonato valendo!
            <small>Dê sua nota pelo celular enquanto cada pessoa canta.</small>
          </div>
        )}
        {settings?.tv_message && <div className="tv-message">{settings.tv_message}</div>}

        <div className="sing">
          {open && singUrl ? (
            <>
              <div className="qr">
                <QRCode value={singUrl} size={140} />
              </div>
              <span>
                Escaneie
                <br />
                para cantar
              </span>
            </>
          ) : (
            <span className="muted">Fila fechada por hoje</span>
          )}
        </div>

        <button className="gear" title="Configurações" aria-label="Configurações" onClick={() => setShowSettings(true)}>
          <Icon name="gear" size={16} />
        </button>
        {pendingCount > 0 && (
          <span className="pending-dot" title="Pessoas aguardando aprovação">
            {pendingCount}
          </span>
        )}
      </aside>

      {showSettings && (
        <div className="modal" onClick={() => setShowSettings(false)}>
          <div className="card" onClick={(e) => e.stopPropagation()}>
            <h2>Painel do admin</h2>
            <p className="muted">Escaneie com o celular do admin para abrir o painel.</p>
            {adminUrl && (
              <div className="qr">
                <QRCode value={adminUrl} size={220} />
              </div>
            )}
            <div className="row">
              <button className="btn" onClick={skipNow} disabled={!playing}>
                <Icon name="skip" /> Pular música
              </button>
              <button
                className="btn"
                onClick={() =>
                  document.fullscreenElement ? document.exitFullscreen?.() : document.documentElement.requestFullscreen?.()
                }
              >
                <Icon name="full" /> Tela cheia
              </button>
              <button className="btn ghost" onClick={() => setShowSettings(false)}>
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

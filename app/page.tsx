'use client';
import { useEffect, useRef, useState } from 'react';
import QRCode from 'react-qr-code';
import AdminLogin from '@/components/AdminLogin';
import { useAdmin } from '@/lib/useAdmin';
import Icon from '@/components/Icon';
import Avatar from '@/components/Avatar';
import SongSearch from '@/components/SongSearch';
import { listenInserts, post, useLive, type ApiError } from '@/lib/useLive';
import { browserClient } from '@/lib/supabase-browser';
import { fmtScore, isGifUrl, photoUrl, REACTIONS, scorePhrase, STICKERS, type QueueItem, type SearchResult, type Settings } from '@/lib/types';

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

/** The video waits while the admin paused it or while a ranking (contest or night) is on screen. */
const onHold = (s: Settings | null) => !!s && (s.paused || s.results_contest_id != null || (s.ranking_on_tv && s.ranking_enabled));

// Video options on the projector (the small gear next to pause / skip).
const RATES = [0.75, 1, 1.25] as const;
const QUALITY_LABELS: Record<string, string> = {
  tiny: '144p', small: '240p', medium: '360p', large: '480p', hd720: '720p', hd1080: '1080p', hd1440: '1440p', hd2160: '4K', highres: '4K+',
};
const CC_KEY = 'karaoke_cc';
const NIGHT_CHECK_EVERY = 10 * 60 * 1000;
const NIGHT_GATE_MAX = 5000; // never hold the karaoke longer than this waiting for the night check
const SCORE_CARD_MS = 7000;
const GIF_MS = 7000;

interface TvGif {
  id: number;
  kind: 'gif' | 'sticker';
  ref: string;
  name: string;
}

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
// Right after a video is loaded the player can still report the previous one ("ended", its
// time). Nothing is decided from those readings during this moment.
const LOAD_GRACE = 5000;
// Ranking or contest results on screen hold the queue. With people waiting they close by themselves after this.
const HOLD_AUTOCLOSE_MS = 3 * 60 * 1000;

// Only one projector screen plays the karaoke. Each open screen has an id (kept across a reload of
// the same tab) and says "I am here" every few seconds; a second screen becomes a mirror.
const TV_ID_KEY = 'karaoke_tv_id';
const TV_BEAT_MS = 8000;
// A screen that is a mirror never takes the karaoke by itself. The only exception: the projector
// itself reopened (Chrome restarted) in its first minutes, while the old screen's lock runs out.
const TV_FRESH_MS = 2 * 60 * 1000;
// No answer about who is in charge after this long: play anyway (a projector never waits forever).
const TV_CHECK_MAX = 6000;
// Time for another tab with the same id (Chrome "Duplicar aba" copies it) to say so.
const TV_DUP_WAIT = 400;
function newTvId(): string {
  const id = `tv${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  try {
    sessionStorage.setItem(TV_ID_KEY, id);
  } catch {}
  return id;
}
function tvId(): string {
  try {
    const saved = sessionStorage.getItem(TV_ID_KEY);
    if (saved && /^[A-Za-z0-9_-]{8,64}$/.test(saved)) return saved;
  } catch {}
  return newTvId();
}

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
// Generous: a slow connection or an ad before the song also keeps the video "not started" a while.
const SOUND_CHECK_AFTER = 12000;
// Playing muted: each song tries the sound again this long after it starts moving.
const SOUND_RETRY_AFTER = 1500;
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
  const { queue, singers, settings, results, ranking, loaded, refresh } = useLive({ tv: true });
  const [started, setStarted] = useState(startedOnce);
  // 'owner' plays the karaoke; 'mirror' is a second screen that only shows the queue; 'checking'
  // while the first answer about who is in charge has not come (nothing plays meanwhile)
  const [role, setRole] = useState<'checking' | 'owner' | 'mirror'>('checking');
  const openedAt = useRef(Date.now());
  const [mayReclaim, setMayReclaim] = useState(false); // mirror that will take over by itself soon
  const roleRef = useRef(role);
  roleRef.current = role;
  const tvIdRef = useRef('');
  const [takingOver, setTakingOver] = useState(false);
  const [muted, setMuted] = useState(false); // playing without sound: waiting for a click
  const [showSettings, setShowSettings] = useState(false);
  const [origin, setOrigin] = useState('');
  const [intro, setIntro] = useState<{ id: number; left: number } | null>(null);
  const [notice, setNotice] = useState('');
  const [floaters, setFloaters] = useState<{ id: number; emoji: string; x: number; size: number; dur: number }[]>([]);
  // last night's leftovers are cleaned before the first song of the day is allowed to start
  const [nightReady, setNightReady] = useState(false);
  const nightReadyRef = useRef(false);
  const [scoreCard, setScoreCard] = useState<{ queueId: number; singerId: string; name: string; title: string; score: number } | null>(null);
  const [gif, setGif] = useState<TvGif | null>(null);
  // video options (gear)
  const [videoMenu, setVideoMenu] = useState(false);
  const [rate, setRate] = useState(1);
  const [cc, setCc] = useState(false);
  const [ytControls, setYtControls] = useState(false); // YouTube's own controls, to pick the quality by hand
  const [quality, setQuality] = useState('');
  const rateRef = useRef(1);
  rateRef.current = rate;
  const ccRef = useRef(false);
  ccRef.current = cc;
  const ytControlsRef = useRef(false);
  ytControlsRef.current = ytControls;
  const ccAppliedTo = useRef<number | null>(null);

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
  const loadedAt = useRef(0); // when the player was last told to load a video
  const soundTried = useRef<number | null>(null); // queue id whose sound was already retried

  useEffect(() => {
    setOrigin(window.location.origin);
    if (wasStarted()) setStarted(true);
    try {
      if (localStorage.getItem(CC_KEY) === '1') setCc(true);
    } catch {}
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

  /**
   * Playing muted because Chrome held the sound once: every new song tries the sound again. If
   * Chrome still refuses, it pauses the video; then it goes back to muted and keeps playing.
   * So one false alarm (slow video, an ad) never leaves the whole night silent.
   */
  function trySoundAgain() {
    const id = loadedVideo.current;
    if (!mutedRef.current || id == null || soundTried.current === id) return;
    soundTried.current = id;
    setTimeout(() => {
      const p = playerRef.current;
      if (!p || !mutedRef.current || loadedVideo.current !== id || onHold(settingsRef.current)) return;
      if (p.getPlayerState?.() !== 1) return;
      p.unMute?.();
      p.setVolume?.(settingsRef.current?.volume ?? 100);
      setTimeout(() => {
        const pl = playerRef.current;
        if (!pl || loadedVideo.current !== id || !mutedRef.current) return;
        const st = pl.getPlayerState?.();
        if (st === 1 || st === 3) {
          // the sound is allowed now
          mutedRef.current = false;
          setMuted(false);
        } else if (!onHold(settingsRef.current)) goMuted();
      }, 1500);
    }, SOUND_RETRY_AFTER);
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
    if (roleRef.current !== 'owner') return false;
    // another request is on its way: this one is dropped, not stored (the watchdog sees again
    // anything that really needs the queue to move)
    if (advancing.current) return false;
    if (retry && id != null) pending.current = { id, endStatus };
    advancing.current = true;
    try {
      await post('/api/player', { current: id, endStatus, tv: tvIdRef.current });
      if (pending.current?.id === id) pending.current = null;
      void refresh();
      return true;
    } catch (e) {
      console.error(e);
      // logged out (password changed, cookies cleared): without this the queue would stop silently
      if ((e as ApiError).status === 401) onLogout();
      // another screen took over the karaoke: this one becomes a mirror
      if ((e as ApiError).status === 409) {
        pending.current = null;
        setRole('mirror');
      }
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

  // Small controls on the projector itself (same effect as the buttons on the admin phone).
  const [ctrlBusy, setCtrlBusy] = useState(false);
  async function control(body: { paused: boolean } | { restart: true } | { rankingOnTv: boolean }) {
    if (ctrlBusy) return;
    setCtrlBusy(true);
    try {
      await post('/api/admin/settings', body);
      await refresh();
    } catch (e) {
      if ((e as ApiError).status === 401) onLogout();
      else flash((e as Error).message);
    } finally {
      setCtrlBusy(false);
    }
  }

  // "Add a request" on the projector PC, for someone without a phone. Goes straight to the queue.
  const [showAdd, setShowAdd] = useState(false);
  const [addName, setAddName] = useState('');
  const [added, setAdded] = useState('');
  async function addRequest(song: SearchResult) {
    const name = addName.trim();
    if (!name) throw new Error('Põe o nome da pessoa primeiro');
    try {
      await post('/api/admin/queue', { action: 'add', from: 'tv', name, song });
    } catch (e) {
      if ((e as ApiError).status === 401) onLogout();
      throw e;
    }
    setAdded(`${name} entrou na fila.`);
    setAddName('');
    void refresh();
  }
  const canAdd = !!settings?.tv_add_enabled && (settings?.queue_open ?? true);

  function clearIntro() {
    if (introTimer.current) clearInterval(introTimer.current);
    introTimer.current = null;
    setIntro(null);
  }

  function startVideo(item: QueueItem, startSeconds: number) {
    const p = playerRef.current;
    if (!p || loadedVideo.current !== item.id) return;
    videoStarted.current = true;
    loadedAt.current = Date.now();
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
    loadedAt.current = Date.now();
    p.loadVideoById({ videoId: cur.video_id, startSeconds: h.lastTime > 3 ? Math.floor(h.lastTime) : 0 });
  }

  /**
   * Captions on/off. Not part of YouTube's documented API, so everything is optional and guarded:
   * if it does nothing, the video simply plays as before.
   */
  function applyCaptions(on: boolean, announce = false) {
    const p = playerRef.current;
    if (!p) return;
    try {
      if (!on) {
        p.unloadModule?.('captions');
        return;
      }
      p.loadModule?.('captions');
      setTimeout(() => {
        try {
          const list: { languageCode?: string }[] = playerRef.current?.getOption?.('captions', 'tracklist') ?? [];
          if (!list.length) {
            if (announce) flash('Esse vídeo não tem legenda pra ligar.');
            return;
          }
          const pick = list.find((t) => String(t.languageCode ?? '').startsWith('pt')) ?? list[0];
          playerRef.current?.setOption?.('captions', 'track', { languageCode: pick.languageCode });
        } catch {}
      }, 1500);
    } catch {}
  }

  function syncPlayer() {
    const p = playerRef.current;
    if (!p || !playerReady.current || !nightReadyRef.current) return;
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
  const isOwner = role === 'owner';
  useEffect(() => {
    if (!started || !isOwner) return;
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
          playerVars: { autoplay: 1, controls: ytControlsRef.current ? 1 : 0, rel: 0, modestbranding: 1, playsinline: 1, iv_load_policy: 3, fs: 0, disablekb: 1 },
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
              if (e.data === YT.PlayerState.PLAYING) {
                // it is moving: whatever the watchdog counted while it waited starts over
                health.current.stalledMs = 0;
                // loading a video puts the speed back to normal: apply the chosen one again
                try {
                  if (rateRef.current !== 1) playerRef.current?.setPlaybackRate?.(rateRef.current);
                } catch {}
                if (ccRef.current && ccAppliedTo.current !== loadedVideo.current) {
                  ccAppliedTo.current = loadedVideo.current;
                  applyCaptions(true);
                }
                trySoundAgain();
              }
              // an "ended" right after loading belongs to the previous video
              if (
                e.data === YT.PlayerState.ENDED &&
                videoStarted.current &&
                loadedVideo.current != null &&
                Date.now() - loadedAt.current > LOAD_GRACE
              ) {
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
              flash('Esse vídeo não quis tocar. Vamos pro próximo!');
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
        flash('Conectando no YouTube… Dá uma olhada na internet do computador.', true);
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
      setIntro(null); // a countdown must not stay frozen on a screen that just became a mirror
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
  }, [started, ytControls, isOwner]);

  // "I am the projector": claimed when the screen opens and renewed every few seconds. Any doubt
  // (no answer, database not updated) keeps this screen playing: only a clear "another screen is in
  // charge" turns it into a mirror. A mirror stays a mirror until someone presses "Assumir": it
  // never takes the karaoke by itself (the projector's internet blinking must not move the music).
  useEffect(() => {
    tvIdRef.current = tvId();
    let stop = false;
    let beatTimer: ReturnType<typeof setInterval> | undefined;
    // Chrome's "Duplicar aba" copies the id: the newer tab takes a new one, so there are never two
    // screens in charge with the same id.
    const born = Date.now();
    const inst = Math.random().toString(36).slice(2);
    let bc: BroadcastChannel | null = null;
    try {
      bc = new BroadcastChannel('karaoke-tv');
      bc.onmessage = (m) => {
        const d = m.data as { id?: string; inst?: string; born?: number } | null;
        if (!d || d.id !== tvIdRef.current || d.inst === inst) return;
        const older = (d.born ?? 0) < born || (d.born === born && String(d.inst) < inst);
        if (older) tvIdRef.current = newTvId();
        else bc?.postMessage({ id: tvIdRef.current, inst, born });
      };
      bc.postMessage({ id: tvIdRef.current, inst, born });
    } catch {}
    // the projector reopened by itself (it ran the karaoke on this computer before)
    const mayTakeBack = () => wasStarted() && Date.now() - openedAt.current < TV_FRESH_MS;
    const beat = async () => {
      const mirror = roleRef.current === 'mirror';
      const passive = mirror && !mayTakeBack();
      try {
        const d = await post('/api/tv', { id: tvIdRef.current, ...(passive ? { passive: true } : {}) });
        if (stop) return;
        if (d?.owner === false) {
          setRole('mirror');
          setMayReclaim(mayTakeBack());
        } else if (d?.owner === true && roleRef.current !== 'owner') setRole('owner');
      } catch (e) {
        if ((e as ApiError).status === 401) onLogout();
      }
    };
    const first = setTimeout(() => {
      void beat();
      beatTimer = setInterval(() => void beat(), TV_BEAT_MS);
    }, TV_DUP_WAIT);
    const failOpen = setTimeout(() => {
      if (!stop && roleRef.current === 'checking') setRole('owner');
    }, TV_CHECK_MAX);
    return () => {
      stop = true;
      clearTimeout(first);
      clearTimeout(failOpen);
      if (beatTimer) clearInterval(beatTimer);
      try {
        bc?.close();
      } catch {}
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function takeOver() {
    setTakingOver(true);
    try {
      const d = await post('/api/tv', { id: tvIdRef.current, force: true });
      if (d?.owner !== false) {
        setRole('owner');
        setStarted(true);
      }
    } catch (e) {
      if ((e as ApiError).status === 401) onLogout();
      else flash((e as Error).message);
    } finally {
      setTakingOver(false);
    }
  }

  // When the projector opens (and every few minutes while it is on): if the bar closed and opened
  // again, the queue of the night before is cleaned. Nothing starts playing before the first check
  // answers, but a slow or failed check never holds the karaoke for more than a few seconds.
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    let stop = false;
    const open = () => {
      if (stop || nightReadyRef.current) return;
      nightReadyRef.current = true;
      setNightReady(true);
    };
    const check = async () => {
      try {
        const d = await post('/api/night', { action: 'auto' });
        if (d?.result === 'reset') await refreshRef.current();
      } catch {}
      open();
    };
    const gate = setTimeout(open, NIGHT_GATE_MAX);
    void check();
    const every = setInterval(() => void check(), NIGHT_CHECK_EVERY);
    return () => {
      stop = true;
      clearTimeout(gate);
      clearInterval(every);
    };
  }, []);

  // react to queue changes
  useEffect(() => {
    if (!started || !loaded || !nightReady || !isOwner) return;
    if (pending.current && pending.current.id !== playing?.id) pending.current = null;
    syncPlayer();
    if (!playing && waiting.length > 0) void advance('done', null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, loaded, nightReady, playing?.id, waiting.length, isOwner]);

  // Night ranking: when a song ends, the database grades it from the reactions it got. Show the
  // grade for a few seconds (it sits on top of the "next singer" countdown).
  const lastSinger = useRef<{ id: number; singerId: string; name: string; title: string } | null>(null);
  const scoreTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const prev = lastSinger.current;
    lastSinger.current = playing ? { id: playing.id, singerId: playing.singer_id, name: singers[playing.singer_id]?.name ?? '', title: playing.title } : null;
    if (!prev || prev.id === playing?.id) return;
    // a new song always starts at normal speed and with YouTube's own controls put away
    setRate(1);
    setYtControls(false);
    setVideoMenu(false);
    const s = settingsRef.current;
    if (!s?.ranking_enabled || s.contest_id) return;
    const t = setTimeout(async () => {
      try {
        const { data } = await browserClient().from('queue').select('id, score').eq('id', prev.id).maybeSingle();
        const score = data && !Array.isArray(data) ? Number((data as { score?: number | null }).score) : NaN;
        if ((data as { score?: number | null } | null)?.score == null || !Number.isFinite(score)) return;
        setScoreCard({ queueId: prev.id, singerId: prev.singerId, name: prev.name, title: prev.title, score });
        if (scoreTimer.current) clearTimeout(scoreTimer.current);
        scoreTimer.current = setTimeout(() => setScoreCard(null), SCORE_CARD_MS);
      } catch {}
    }, 600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing?.id]);
  useEffect(() => () => void (scoreTimer.current && clearTimeout(scoreTimer.current)), []);

  // GIFs and stickers sent from the phones: one at a time, in a corner of the video
  const gifsOn = !!settings?.gifs_enabled;
  useEffect(() => {
    if (!gifsOn) return;
    const line: TvGif[] = [];
    let showing = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const next = () => {
      const g = line.shift();
      showing = !!g;
      setGif(g ?? null);
      if (g) timer = setTimeout(next, GIF_MS);
    };
    const stopListening = listenInserts('tv_gifs', (raw) => {
      const r = raw as { id?: number; kind?: string; ref?: string; name?: string };
      const ref = String(r.ref ?? '');
      const ok = r.kind === 'gif' ? isGifUrl(ref) : r.kind === 'sticker' && STICKERS.some((s) => s.key === ref);
      // a burst never piles up: at most 4 waiting
      if (!ok || line.length >= 4) return;
      line.push({ id: Number(r.id) || Date.now(), kind: r.kind as 'gif' | 'sticker', ref, name: String(r.name ?? '').slice(0, 40) });
      if (!showing) next();
    });
    return () => {
      stopListening();
      if (timer) clearTimeout(timer);
      setGif(null);
    };
  }, [gifsOn]);

  // video options: speed
  useEffect(() => {
    try {
      if (playerReady.current && videoStarted.current) playerRef.current?.setPlaybackRate?.(rate);
    } catch {}
  }, [rate]);

  function toggleCaptions() {
    const on = !cc;
    setCc(on);
    try {
      localStorage.setItem(CC_KEY, on ? '1' : '0');
    } catch {}
    ccAppliedTo.current = on ? loadedVideo.current : null;
    applyCaptions(on, true);
  }

  function openVideoMenu() {
    try {
      setQuality(String(playerRef.current?.getPlaybackQuality?.() ?? ''));
    } catch {}
    setVideoMenu((v) => !v);
  }

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
    let n = 0;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const stopListening = listenInserts('reactions', (row) => {
        const emoji = REACTIONS.find((r) => r.key === (row as { emoji?: string }).emoji)?.emoji;
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
    });
    return () => {
      stopListening();
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
    if (!started || !isOwner) return;
    const t = setInterval(() => {
      if (!loadedRef.current || !nightReadyRef.current) return;
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
      // Just loaded: the player may still be showing the previous video's state and time, so
      // nothing is ended from those readings. And if the player says which video it has, it must
      // be this song's.
      const settling = Date.now() - loadedAt.current < LOAD_GRACE;
      let onScreen = '';
      try {
        onScreen = String(p.getVideoData?.()?.video_id ?? '');
      } catch {}
      const trusted = !settling && (!onScreen || onScreen === cur.video_id);
      const time = Number(p.getCurrentTime()) || 0;
      const state: number | undefined = p.getPlayerState?.();
      const max = settingsRef.current?.max_duration_sec ?? 360;
      if (trusted && time > max + 15) return void advance('done', cur.id);
      // finished, but the "ended" event was lost
      if (trusted && state === 0) return void advance('done', cur.id);

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
      if (settling) return; // not moving yet: too early to call it stuck
      if (onHold(settingsRef.current)) return void (h.stalledMs = 0); // stopped on purpose
      if (!isOnline()) return; // no network at all: wait for it, never punish the singer
      h.stalledMs += TICK;

      if (state === 2 || state === 5) {
        // paused by a stray click, or left ready but not playing (the "play" was lost when a
        // pause or the ranking ended while the video was loading)
        if (h.stalledMs >= RESUME_PAUSED_AFTER) p.playVideo?.();
        return;
      }
      // not started yet: one "play" nudge too, in case it was lost in the same way
      if (state === -1 && !h.everPlayed && h.stalledMs === RESUME_PAUSED_AFTER) p.playVideo?.();
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
          flash('O vídeo não tá carregando. Dá uma olhada na internet do computador.', true);
          return reloadVideo();
        }
        flash('Esse vídeo não carregou. Vamos pro próximo!');
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
  }, [started, isOwner]);

  // A ranking or contest result left on screen holds the queue. With people waiting, it closes by
  // itself after a few minutes (the admin can show it again any time).
  const rankingShown = !!settings?.ranking_enabled && !!settings?.ranking_on_tv && !results;
  const resultsShown = settings?.results_contest_id != null;
  const holdingSomeone = (rankingShown || resultsShown) && waiting.length > 0 && isOwner && started;
  useEffect(() => {
    if (!holdingSomeone) return;
    // straight to the server (not through the buttons, which skip while another tap is running),
    // and again every 30 s until it really closed (a failed request must not hold the queue)
    let again: ReturnType<typeof setInterval> | undefined;
    const close = async () => {
      const s = settingsRef.current;
      try {
        if (s?.results_contest_id != null) await post('/api/admin/contest', { action: 'hide' });
        else if (s?.ranking_on_tv) await post('/api/admin/settings', { rankingOnTv: false });
        void refresh();
      } catch (e) {
        if ((e as ApiError).status === 401) onLogout();
      }
    };
    const t = setTimeout(() => {
      void close();
      again = setInterval(() => void close(), 30000);
    }, HOLD_AUTOCLOSE_MS);
    return () => {
      clearTimeout(t);
      if (again) clearInterval(again);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holdingSomeone]);

  async function hideResults() {
    if (ctrlBusy) return;
    setCtrlBusy(true);
    try {
      await post('/api/admin/contest', { action: 'hide' });
      await refresh();
    } catch (e) {
      if ((e as ApiError).status === 401) onLogout();
      else flash((e as Error).message);
    } finally {
      setCtrlBusy(false);
    }
  }

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
  const photoOf = (singerId: string | null | undefined) => (singerId ? photoUrl(singers[singerId], settings) : null);
  const open = settings?.queue_open ?? true;
  const showVideo = !!playing && !intro && isOwner;
  const winner = results?.[0]?.score != null ? results[0] : null;
  const SHOWN = 8;
  const rankingOn = !!settings?.ranking_enabled;
  const showRanking = rankingOn && !!settings?.ranking_on_tv && !results;
  const scorePos = scoreCard ? ranking.findIndex((r) => r.queue_id === scoreCard.queueId) : -1;
  const sticker = gif?.kind === 'sticker' ? STICKERS.find((x) => x.key === gif.ref) : null;

  return (
    <main className="tv">
      <section className="stage">
        <div className={`player-wrap${showVideo ? '' : ' hidden'}${ytControls ? ' interactive' : ''}`}>
          <div className="yt-holder" ref={holderRef} />
        </div>

        {!playing && (
          <div className="idle">
            <div className="idle-text">
              <span className="eyebrow">🍄 Karaokê Cogumelo</span>
              <h1>{open ? 'Quem vai soltar a voz?' : 'Por hoje é só, pessoal!'}</h1>
              {open ? (
                <ol className="steps">
                  <li>Aponta a câmera do celular pro QR code</li>
                  <li>Diz como a gente te chama</li>
                  <li>Escolhe a música e espera a sua vez</li>
                </ol>
              ) : (
                <p>A fila fechou. Valeu por cantar com a gente, até a próxima!</p>
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
            <Avatar src={photoOf(playing.singer_id)} seed={playing.singer_id} size={220} />
            <span className="eyebrow">Agora é com você</span>
            <h1>{nowName}</h1>
            <p>{playing.title}</p>
            <span className="count" key={intro.left}>
              {intro.left}
            </span>
          </div>
        )}

        {showVideo && settings?.paused && !results && !showRanking && <div className="badge-paused">Pausado</div>}

        {floaters.length > 0 && (
          <div className="floaters" aria-hidden="true">
            {floaters.map((f) => (
              <span key={f.id} style={{ left: `${f.x}%`, fontSize: `${f.size * 4.2}vw`, animationDuration: `${f.dur}s` }}>
                {f.emoji}
              </span>
            ))}
          </div>
        )}

        {gif && !results && !showRanking && (
          <div className="gif-pop" key={gif.id}>
            {gif.kind === 'gif' ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={gif.ref} alt="" onError={() => setGif(null)} />
            ) : (
              sticker && (
                <div className={`sticker s-${sticker.key}`}>
                  <span>{sticker.emoji}</span>
                  <strong>{sticker.text}</strong>
                </div>
              )
            )}
            {gif.name && <small>{gif.name} mandou</small>}
          </div>
        )}

        {scoreCard && !results && !showRanking && (
          <div className="score-card">
            <Avatar src={photoOf(scoreCard.singerId)} seed={scoreCard.singerId} size={140} />
            <span className="eyebrow">Nota da galera</span>
            <h1>{fmtScore(scoreCard.score)}</h1>
            <strong>{scoreCard.name}</strong>
            <p>
              {scorePhrase(scoreCard.score)}
              {scorePos >= 0 && ` · ${scorePos + 1}º lugar na noite`}
            </p>
          </div>
        )}

        {showRanking && (
          <div className="results-screen">
            <span className="eyebrow">⭐ Ranking da noite</span>
            {ranking.length === 0 ? (
              <h1 className="smaller">Ninguém pontuou ainda. Bora cantar!</h1>
            ) : (
              <>
                <Avatar src={photoOf(ranking[0].singer_id)} seed={ranking[0].singer_id} size={170} />
                <h1>{ranking[0].name}</h1>
                <p>
                  {ranking[0].title} · nota {fmtScore(ranking[0].score)}
                </p>
                {ranking.length > 1 && (
                  <ol>
                    {ranking.slice(1, 8).map((r, i) => (
                      <li key={r.queue_id}>
                        <span className="pos">{i + 2}</span>
                        <Avatar src={photoOf(r.singer_id)} seed={r.singer_id} size={44} />
                        <strong>{r.name}</strong>
                        <span className="song">{r.title}</span>
                        <span className="pts">{fmtScore(r.score)}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </>
            )}
            <button className="btn small results-close" disabled={ctrlBusy} onClick={() => control({ rankingOnTv: false })}>
              Fechar o ranking
            </button>
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
              <h1 className="smaller">Ninguém votou dessa vez</h1>
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
            {isOwner && (
              <button className="btn small results-close" disabled={ctrlBusy} onClick={() => void hideResults()}>
                Tirar do telão
              </button>
            )}
          </div>
        )}
        {started && isOwner && playing && !results && !showRanking && videoMenu && (
          <div className={`video-menu${ytControls ? ' raised' : ''}`} role="dialog" aria-label="Opções do vídeo">
            <div className="vm-row">
              <span>Velocidade</span>
              <div className="vm-opts">
                {RATES.map((r) => (
                  <button key={r} className={rate === r ? 'on' : ''} aria-pressed={rate === r} onClick={() => setRate(r)}>
                    {r === 1 ? 'Normal' : `${String(r).replace('.', ',')}×`}
                  </button>
                ))}
              </div>
            </div>
            <div className="vm-row">
              <span>Legenda</span>
              <div className="vm-opts">
                <button className={cc ? 'on' : ''} aria-pressed={cc} onClick={toggleCaptions}>
                  {cc ? 'Ligada' : 'Desligada'}
                </button>
              </div>
            </div>
            <div className="vm-row">
              <span>Qualidade{quality && QUALITY_LABELS[quality] ? ` · agora ${QUALITY_LABELS[quality]}` : ''}</span>
              <div className="vm-opts">
                <button className={ytControls ? 'on' : ''} aria-pressed={ytControls} onClick={() => setYtControls((v) => !v)}>
                  {ytControls ? 'Esconder controles do YouTube' : 'Escolher no YouTube'}
                </button>
              </div>
            </div>
            <small>
              {ytControls
                ? 'Clique na engrenagem do próprio YouTube, dentro do vídeo, e escolha a qualidade. Os controles somem sozinhos na próxima música.'
                : 'O YouTube escolhe a qualidade sozinho pela internet. Pra mudar na mão, use “Escolher no YouTube” (o vídeo dá uma piscada e volta no mesmo ponto).'}
            </small>
          </div>
        )}
        {started && isOwner && playing && !results && !showRanking && (
          <div className={`tv-controls${ytControls ? ' raised' : ''}${videoMenu ? ' open' : ''}`}>
            <button
              aria-label={settings?.paused ? 'Continuar' : 'Pausar'}
              title={settings?.paused ? 'Continuar' : 'Pausar'}
              disabled={ctrlBusy}
              onClick={() => control({ paused: !settings?.paused })}
            >
              <Icon name={settings?.paused ? 'play' : 'pause'} size={18} />
            </button>
            <button aria-label="Voltar ao início da música" title="Voltar ao início da música" disabled={ctrlBusy} onClick={() => control({ restart: true })}>
              <Icon name="restart" size={18} />
            </button>
            <button aria-label="Pular para a próxima" title="Pular para a próxima" onClick={skipNow}>
              <Icon name="skip" size={18} />
            </button>
            <button aria-label="Opções do vídeo" title="Opções do vídeo" aria-expanded={videoMenu} onClick={openVideoMenu}>
              <Icon name="gear" size={18} />
            </button>
          </div>
        )}
        {notice && <div className="toast">{notice}</div>}

        {started && isOwner && muted && (
          <button className="sound-overlay" onClick={unmute}>
            <span>🔇 Clique na tela pra ligar o som</span>
          </button>
        )}

        {role === 'mirror' && (
          <div className="mirror-overlay" role="dialog" aria-label="Segundo telão">
            <span className="eyebrow">📺 Segundo telão</span>
            {mayReclaim ? (
              <>
                <h2>Esperando o telão anterior liberar…</h2>
                <p>Parece que o projetor acabou de reabrir. Em até um minuto esta tela volta a tocar sozinha.</p>
              </>
            ) : (
              <>
                <h2>Outro telão tá tocando o karaokê</h2>
                <p>Aqui só mostra a fila, sem vídeo e sem som, pra não cortar a música de ninguém.</p>
              </>
            )}
            <button className="btn primary" disabled={takingOver} onClick={() => void takeOver()}>
              {takingOver ? 'Assumindo…' : 'Assumir o telão aqui'}
            </button>
            <small>Esta tela nunca assume sozinha. Use o botão só se o outro telão desligou ou travou: ele vira o espelho.</small>
          </div>
        )}

        {!started && isOwner && (
          <button className="start-overlay" onClick={() => setStarted(true)}>
            <span className="start-btn">
              <Icon name="play" size={40} />
            </span>
            Clique pra começar o karaokê
            <small>Um clique só, pro navegador liberar o som</small>
          </button>
        )}
      </section>

      <aside className="side">
        <div className="now">
          <span className="label">No palco agora</span>
          <span className="with-avatar">
            {playing && <Avatar src={photoOf(playing.singer_id)} seed={playing.singer_id} size={48} />}
            <strong>{playing ? nowName : loaded ? '—' : '…'}</strong>
          </span>
          {playing && <span className="song">{playing.title}</span>}
        </div>

        <div className="list">
          <span className="label">Próximos {waiting.length > 0 && `· ${waiting.length}`}</span>
          {!loaded ? (
            <p className="muted">Carregando a fila…</p>
          ) : waiting.length === 0 ? (
            <p className="muted">{open ? 'Fila vazia. Bora cantar?' : 'A fila fechou por hoje.'}</p>
          ) : (
            <ol>
              {waiting.slice(0, SHOWN).map((q, i) => (
                <li key={q.id}>
                  <span className="pos">{i + 1}</span>
                  <Avatar src={photoOf(q.singer_id)} seed={q.singer_id} size={36} />
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
            <small>Dá sua nota pelo celular enquanto cada um canta.</small>
          </div>
        )}
        {rankingOn && !settings?.contest_id && ranking.length > 0 && (
          <div className="tv-message ranking-on">
            ⭐ Líder da noite: {ranking[0].name}
            <small>
              Nota {fmtScore(ranking[0].score)}. Reaja pelo celular pra dar nota em quem canta!
            </small>
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
                Escaneia
                <br />
                e vem cantar
              </span>
            </>
          ) : (
            <span className="muted">A fila fechou por hoje</span>
          )}
        </div>

        {canAdd && (
          <button
            className="tv-add"
            title="Adicionar pedido"
            aria-label="Adicionar pedido"
            onClick={() => (setAdded(''), setShowAdd(true))}
          >
            <Icon name="plus" size={16} />
          </button>
        )}
        <button className="gear" title="Configurações" aria-label="Configurações" onClick={() => setShowSettings(true)}>
          <Icon name="gear" size={16} />
        </button>
        {pendingCount > 0 && (
          <span className="pending-dot" title="Gente esperando aprovação">
            {pendingCount}
          </span>
        )}
      </aside>

      {showAdd && (
        <div className="modal" onClick={() => setShowAdd(false)}>
          <div className="card add-card" onClick={(e) => e.stopPropagation()}>
            <h2>Adicionar pedido</h2>
            <label className="field">
              <span>Nome de quem vai cantar</span>
              <input placeholder="Nome" maxLength={40} value={addName} autoFocus onChange={(e) => (setAddName(e.target.value), setAdded(''))} />
            </label>
            {added && <p className="ok">{added}</p>}
            <SongSearch maxDurationSec={settings?.max_duration_sec ?? 360} pickLabel="Adicionar" onPick={addRequest} />
            <button className="btn ghost self-start" onClick={() => setShowAdd(false)}>
              Fechar
            </button>
          </div>
        </div>
      )}

      {showSettings && (
        <div className="modal" onClick={() => setShowSettings(false)}>
          <div className="card" onClick={(e) => e.stopPropagation()}>
            <h2>Painel do admin</h2>
            <p className="muted">Aponta o celular do admin aqui pra abrir o painel.</p>
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

'use client';
import { useEffect, useRef, useState } from 'react';
import QRCode from 'react-qr-code';
import AdminLogin from '@/components/AdminLogin';
import Icon from '@/components/Icon';
import { post, useLive } from '@/lib/useLive';
import type { QueueItem, Settings } from '@/lib/types';

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    YT: any;
    onYouTubeIframeAPIReady: () => void;
  }
}

function loadYT(): Promise<any> {
  return new Promise((resolve) => {
    if (window.YT?.Player) return resolve(window.YT);
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve(window.YT);
    };
    if (!document.getElementById('yt-api')) {
      const s = document.createElement('script');
      s.id = 'yt-api';
      s.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(s);
    }
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

export default function TvPage() {
  const [admin, setAdmin] = useState<boolean | null>(null);
  useEffect(() => {
    fetch('/api/admin/login')
      .then((r) => r.json())
      .then((d) => setAdmin(!!d.admin))
      .catch(() => setAdmin(false));
  }, []);
  if (admin === null)
    return (
      <main className="center">
        <span className="spinner big" aria-label="Carregando" />
      </main>
    );
  if (!admin) return <AdminLogin title="Tela do projetor" onOk={() => setAdmin(true)} />;
  return <Tv />;
}

function Tv() {
  const { queue, singers, settings, loaded } = useLive();
  const [started, setStarted] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [origin, setOrigin] = useState('');
  const [intro, setIntro] = useState<{ id: number; left: number } | null>(null);
  const [notice, setNotice] = useState('');

  const playerRef = useRef<any>(null);
  const playerReady = useRef(false);
  const loadedVideo = useRef<number | null>(null); // queue id the player is on (or counting down to)
  const videoStarted = useRef(false); // false while the "next singer" countdown runs
  const advancing = useRef(false);
  const introTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => setOrigin(window.location.origin), []);

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

  function flash(msg: string) {
    setNotice(msg);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(''), 6000);
  }

  async function advance(endStatus: 'done' | 'skipped') {
    if (advancing.current) return;
    advancing.current = true;
    try {
      await post('/api/player', { current: playingRef.current?.id ?? null, endStatus });
    } catch (e) {
      console.error(e);
    } finally {
      setTimeout(() => (advancing.current = false), 1500);
    }
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
    p.setVolume?.(settingsRef.current?.volume ?? 100);
    p.loadVideoById({ videoId: item.video_id, startSeconds });
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

    let left = wait;
    setIntro({ id: cur.id, left });
    introTimer.current = setInterval(() => {
      left -= 1;
      if (left > 0) return setIntro({ id: cur.id, left });
      clearIntro();
      startVideo(cur, 0);
    }, 1000);
  }

  // create the player once the user has clicked "start" (needed so the browser allows sound)
  useEffect(() => {
    if (!started) return;
    let cancelled = false;
    loadYT().then((YT) => {
      if (cancelled) return;
      playerRef.current = new YT.Player('yt-player', {
        width: '100%',
        height: '100%',
        playerVars: { autoplay: 1, controls: 0, rel: 0, modestbranding: 1, playsinline: 1, iv_load_policy: 3, fs: 0, disablekb: 1 },
        events: {
          onReady: () => {
            playerReady.current = true;
            loadedVideo.current = null;
            syncPlayer();
          },
          onStateChange: (e: any) => {
            if (e.data === YT.PlayerState.ENDED && videoStarted.current) {
              writeProgress(null);
              advance('done');
            }
            // admin paused from the phone while the video was still loading
            if (e.data === YT.PlayerState.PLAYING && settingsRef.current?.paused) playerRef.current?.pauseVideo?.();
          },
          onError: () => {
            // video blocked for embedding, removed, etc.
            if (!videoStarted.current) return;
            flash('Este vídeo não pôde ser tocado. Passando para o próximo.');
            writeProgress(null);
            advance('skipped');
          },
        },
      });
    });
    return () => {
      cancelled = true;
      if (introTimer.current) clearInterval(introTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started]);

  // react to queue changes
  useEffect(() => {
    if (!started || !loaded) return;
    syncPlayer();
    if (!playing && waiting.length > 0) advance('done');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, loaded, playing?.id, waiting.length]);

  // remote control from the admin phone: pause / resume
  useEffect(() => {
    const p = playerRef.current;
    if (!p || !playerReady.current || !videoStarted.current) return;
    if (settings?.paused) p.pauseVideo?.();
    else p.playVideo?.();
  }, [settings?.paused]);

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
    p.seekTo?.(0, true);
    p.playVideo?.();
  }, [settings?.restart_at, settings]);

  // every few seconds: save progress, enforce the time limit, and un-stick the queue if needed
  useEffect(() => {
    if (!started) return;
    const t = setInterval(() => {
      if (!loadedRef.current) return;
      const cur = playingRef.current;
      if (!cur) {
        // someone is waiting but nothing is playing (e.g. a request was lost): try again
        if (waitingRef.current > 0) advance('done');
        return;
      }
      const p = playerRef.current;
      if (!p?.getCurrentTime || !videoStarted.current || loadedVideo.current !== cur.id) return;
      const time = p.getCurrentTime();
      const max = settingsRef.current?.max_duration_sec ?? 360;
      if (time > max + 15) return void advance('done');
      if (p.getPlayerState?.() === 1) writeProgress({ id: cur.id, t: time });
    }, 3000);
    return () => clearInterval(t);
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
  const SHOWN = 8;

  return (
    <main className="tv">
      <section className="stage">
        <div className={showVideo ? 'player-wrap' : 'player-wrap hidden'}>
          <div id="yt-player" />
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

        {showVideo && settings?.paused && <div className="badge-paused">Pausado</div>}
        {notice && <div className="toast">{notice}</div>}

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
              <button className="btn" onClick={() => advance('skipped')} disabled={!playing}>
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

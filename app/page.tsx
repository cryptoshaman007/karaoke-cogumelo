'use client';
import { useEffect, useRef, useState } from 'react';
import QRCode from 'react-qr-code';
import AdminLogin from './AdminLogin';
import { post, useLive } from '@/lib/useLive';

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

export default function TvPage() {
  const [admin, setAdmin] = useState<boolean | null>(null);
  useEffect(() => {
    fetch('/api/admin/login').then((r) => r.json()).then((d) => setAdmin(!!d.admin)).catch(() => setAdmin(false));
  }, []);
  if (admin === null) return <main className="center">Carregando…</main>;
  if (!admin) return <AdminLogin title="Tela do projetor" onOk={() => setAdmin(true)} />;
  return <Tv />;
}

function Tv() {
  const { queue, singers, settings, loaded } = useLive();
  const [started, setStarted] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [origin, setOrigin] = useState('');
  const playerRef = useRef<any>(null);
  const playerReady = useRef(false);
  const loadedVideo = useRef<number | null>(null);
  const advancing = useRef(false);

  useEffect(() => setOrigin(window.location.origin), []);

  const playing = queue.find((q) => q.status === 'playing') ?? null;
  const waiting = queue.filter((q) => q.status === 'waiting' && singers[q.singer_id]?.status === 'approved');
  const pendingCount = queue.filter((q) => q.status === 'waiting' && singers[q.singer_id]?.status === 'pending').length;
  const playingRef = useRef(playing);
  playingRef.current = playing;

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

  // create the player once the user has clicked "start" (needed so the browser allows sound)
  useEffect(() => {
    if (!started) return;
    let cancelled = false;
    loadYT().then((YT) => {
      if (cancelled) return;
      playerRef.current = new YT.Player('yt-player', {
        width: '100%',
        height: '100%',
        playerVars: { autoplay: 1, controls: 0, rel: 0, modestbranding: 1, playsinline: 1, iv_load_policy: 3, fs: 0 },
        events: {
          onReady: () => {
            playerReady.current = true;
            loadedVideo.current = null;
            syncPlayer();
          },
          onStateChange: (e: any) => {
            if (e.data === YT.PlayerState.ENDED) advance('done');
          },
          onError: () => advance('skipped'), // video blocked for embedding, removed, etc.
        },
      });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started]);

  function syncPlayer() {
    const p = playerRef.current;
    if (!p || !playerReady.current) return;
    const cur = playingRef.current;
    if (!cur) {
      if (loadedVideo.current !== null) {
        p.stopVideo?.();
        loadedVideo.current = null;
      }
      return;
    }
    if (loadedVideo.current !== cur.id) {
      loadedVideo.current = cur.id;
      p.loadVideoById(cur.video_id);
    }
  }

  // react to queue changes
  useEffect(() => {
    if (!started || !loaded) return;
    syncPlayer();
    if (!playing && waiting.length > 0) advance('done');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, loaded, playing?.id, waiting.length]);

  // safety: never play longer than the configured limit (+15s tolerance)
  useEffect(() => {
    if (!started) return;
    const t = setInterval(() => {
      const p = playerRef.current;
      const max = settings?.max_duration_sec ?? 360;
      if (playingRef.current && p?.getCurrentTime && p.getCurrentTime() > max + 15) advance('done');
    }, 5000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [started, settings?.max_duration_sec]);

  const singUrl = origin ? `${origin}/cantar` : '';
  const adminUrl = origin ? `${origin}/admin` : '';
  const nowName = playing ? singers[playing.singer_id]?.name ?? '' : '';

  return (
    <main className="tv">
      <section className="stage">
        <div className={playing ? 'player-wrap' : 'player-wrap hidden'}>
          <div id="yt-player" />
        </div>
        {!playing && (
          <div className="idle">
            <h1>🍄 Karaokê Cogumelo</h1>
            <p>Escaneie o QR code e escolha sua música!</p>
            {singUrl && (
              <div className="qr big">
                <QRCode value={singUrl} size={300} />
              </div>
            )}
          </div>
        )}
        {!started && (
          <button className="start-overlay" onClick={() => setStarted(true)}>
            ▶ Clique para iniciar o karaokê
            <small>(necessário para liberar o som do navegador)</small>
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
          <span className="label">Próximos ({waiting.length})</span>
          <ol>
            {waiting.slice(0, 12).map((q) => (
              <li key={q.id}>
                <strong>{singers[q.singer_id]?.name}</strong>
                <span>{q.title}</span>
              </li>
            ))}
          </ol>
          {waiting.length === 0 && <p className="muted">Fila vazia. Bora cantar?</p>}
        </div>

        <div className="sing">
          {singUrl && (
            <div className="qr">
              <QRCode value={singUrl} size={150} />
            </div>
          )}
          <span>Escaneie para cantar</span>
        </div>

        <button className="gear" title="Configurações" onClick={() => setShowSettings(true)}>
          ⚙
        </button>
        {pendingCount > 0 && <span className="pending-dot" title="Pessoas aguardando aprovação">{pendingCount}</span>}
      </aside>

      {showSettings && (
        <div className="modal" onClick={() => setShowSettings(false)}>
          <div className="card" onClick={(e) => e.stopPropagation()}>
            <h2>Configurações</h2>
            <p>Escaneie com o celular do admin para abrir o painel:</p>
            {adminUrl && (
              <div className="qr">
                <QRCode value={adminUrl} size={220} />
              </div>
            )}
            <div className="row">
              <button className="btn" onClick={() => advance('skipped')} disabled={!playing}>
                ⏭ Pular música
              </button>
              <button className="btn" onClick={() => document.documentElement.requestFullscreen?.()}>
                ⛶ Tela cheia
              </button>
              <button className="btn" onClick={() => setShowSettings(false)}>
                Fechar
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

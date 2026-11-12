'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import SongSearch from '@/components/SongSearch';
import { del, post, useLive } from '@/lib/useLive';
import type { SearchResult, Singer } from '@/lib/types';

const TOKEN_KEY = 'karaoke_token';

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
        const res = await fetch('/api/me', { headers: { 'x-singer-token': token }, cache: 'no-store' });
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
            <span className="muted small">Escolha sua música e cante no telão</span>
          </div>
        </div>
        <label className="field">
          <span>Como devemos te chamar?</span>
          <input
            placeholder="Seu nome"
            maxLength={40}
            autoComplete="given-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </label>
        {err && <p className="error" role="alert">{err}</p>}
        <button className="btn primary block" disabled={busy || !name.trim()}>
          {busy ? 'Entrando…' : 'Continuar'}
        </button>
      </form>
    </main>
  );
}

function Room({ me, token }: { me: Singer; token: string }) {
  const { queue, singers, settings, loaded, refresh } = useLive({ selfId: me.id });
  const [err, setErr] = useState('');
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t);
  }, []);

  const self = singers[me.id] ?? me;
  const playing = queue.find((q) => q.status === 'playing') ?? null;
  const line = queue.filter((q) => q.status === 'waiting' && singers[q.singer_id]?.status === 'approved');
  const entry = queue.find((q) => q.singer_id === me.id) ?? null;
  const ahead = entry?.status === 'waiting' ? line.findIndex((q) => q.id === entry.id) : -1;
  const maxDurationSec = settings?.max_duration_sec ?? 360;
  const open = settings?.queue_open ?? true;

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

  // buzz the phone when the turn is coming
  const stage = entry?.status === 'playing' ? 'playing' : ahead === 0 ? 'next' : 'other';
  const prevStage = useRef(stage);
  useEffect(() => {
    if (stage !== prevStage.current && stage !== 'other') {
      try {
        navigator.vibrate?.(stage === 'playing' ? [300, 120, 300, 120, 500] : [200, 100, 200]);
      } catch {}
    }
    prevStage.current = stage;
  }, [stage]);

  const add = useCallback(
    async (song: SearchResult) => {
      await post('/api/queue', song, { 'x-singer-token': token });
      await refresh();
    },
    [token, refresh],
  );

  async function removeMine() {
    if (!confirm('Tirar sua música da fila?')) return;
    setErr('');
    try {
      await del('/api/queue', { 'x-singer-token': token });
      await refresh();
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  if (!loaded) return <Loading />;

  return (
    <main className="phone">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">🍄</span>
          <strong>Karaokê Cogumelo</strong>
        </div>
        <span className="chip">{self.name}</span>
      </header>

      {self.status === 'blocked' && (
        <p className="banner danger">O admin não liberou você para cantar hoje.</p>
      )}
      {self.status === 'pending' && (
        <p className="banner warn">
          Aguardando o admin liberar sua entrada. {entry ? 'Sua música entra na fila assim que ele aprovar.' : 'Você já pode escolher a música.'}
        </p>
      )}
      {err && <p className="error" role="alert">{err}</p>}

      {self.status !== 'blocked' && entry && (
        <section className={`card mysong ${stage}`}>
          <span className="label">
            {entry.status === 'playing' ? 'Cantando agora' : self.status === 'pending' ? 'Sua música' : 'Sua música na fila'}
          </span>
          <div className="mysong-row">
            {entry.thumbnail && <img src={entry.thumbnail} alt="" width={112} height={63} />}
            <strong>{entry.title}</strong>
          </div>
          {entry.status === 'playing' ? (
            <p className="big-msg">É a sua vez! Pega o microfone 🎤</p>
          ) : self.status === 'pending' ? null : ahead === 0 ? (
            <p className="big-msg">Você é o próximo. Prepare-se!</p>
          ) : ahead > 0 ? (
            <div className="stats">
              <div>
                <strong>{ahead}</strong>
                <span className="muted small">{ahead === 1 ? 'pessoa na frente' : 'pessoas na frente'}</span>
              </div>
              {waitMin !== null && (
                <div>
                  <strong>~{waitMin} min</strong>
                  <span className="muted small">de espera</span>
                </div>
              )}
            </div>
          ) : null}
          {entry.status === 'waiting' && (
            <button className="btn ghost" onClick={removeMine}>
              Trocar ou tirar música
            </button>
          )}
        </section>
      )}

      {self.status !== 'blocked' && !entry && !open && (
        <p className="banner">A fila está fechada por hoje. Obrigado por cantar com a gente!</p>
      )}

      {self.status !== 'blocked' && !entry && open && (
        <section>
          <SongSearch
            authHeaders={{ 'x-singer-token': token }}
            maxDurationSec={maxDurationSec}
            pickLabel="Cantar"
            onPick={add}
            showPopular
          />
          <p className="muted small hint">
            Só versões karaokê de até {Math.floor(maxDurationSec / 60)} minutos. Uma música por vez.
          </p>
        </section>
      )}

      {(playing || line.length > 0) && (
        <section className="card">
          <span className="label">Fila agora</span>
          <ol className="line">
            {playing && (
              <li className={playing.singer_id === me.id ? 'me' : ''}>
                <span className="pos live">♪</span>
                <div className="grow">
                  <strong>{singers[playing.singer_id]?.name ?? '…'}</strong>
                  <span className="muted small">{playing.title}</span>
                </div>
              </li>
            )}
            {line.slice(0, 15).map((q, i) => (
              <li key={q.id} className={q.singer_id === me.id ? 'me' : ''}>
                <span className="pos">{i + 1}</span>
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
    </main>
  );
}

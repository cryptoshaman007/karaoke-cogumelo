'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Ranking from '@/components/Ranking';
import SongSearch from '@/components/SongSearch';
import { del, get, post, useLive } from '@/lib/useLive';
import { timeoutSignal } from '@/lib/timeout';
import { REACTIONS, SCORE_EMOJIS, SCORE_LABELS, type QueueItem, type Reserve, type SearchResult, type Singer } from '@/lib/types';

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
  const { queue, singers, settings, results, loaded, refresh } = useLive({ selfId: me.id });
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
  const contestOn = !!settings?.contest_id;
  const canInteract = self.status === 'approved';

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

  async function removeMine() {
    if (!confirm('Tirar sua música da fila?')) return;
    setErr('');
    try {
      await del('/api/queue', { 'x-singer-token': token });
      await Promise.all([refresh(), loadReserves()]);
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

      {results && (
        <section className="card contest">
          <span className="label">🏆 Resultado do campeonato</span>
          {results[0]?.score != null && (
            <p className="big-msg">
              {results[0].name} venceu!
            </p>
          )}
          <Ranking rows={results} limit={10} highlightFirst />
        </section>
      )}

      {contestOn && playing && playing.singer_id === me.id && (
        <section className="card contest">
          <span className="label">🏆 Campeonato valendo</span>
          <p>A galera está dando nota para você agora. Capricha!</p>
        </section>
      )}
      {contestOn && playing && playing.singer_id !== me.id && canInteract && (
        <VoteCard token={token} playing={playing} performer={singers[playing.singer_id]?.name ?? 'quem está cantando'} />
      )}
      {contestOn && !playing && (
        <p className="banner contest-banner">🏆 Campeonato valendo! Dê sua nota para cada pessoa enquanto ela canta.</p>
      )}

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
          <span className="muted small">Entra no fim da fila depois que você cantar a música atual.</span>
        </section>
      )}

      {canReserve && (
        <section>
          <h2 className="section-title">Quer deixar mais uma escolhida?</h2>
          <SongSearch authHeaders={{ 'x-singer-token': token }} maxDurationSec={maxDurationSec} pickLabel="Guardar" onPick={add} />
          <p className="muted small hint">
            Ela fica de reserva e entra no fim da fila depois que você cantar. Até {maxSongs} músicas por pessoa.
          </p>
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

      {playing && canInteract && settings?.reactions_enabled && <ReactionBar token={token} />}
    </main>
  );
}

/** Contest mode: five faces, from "off key" to "nailed it". The vote can be changed until the song ends. */
function VoteCard({ token, playing, performer }: { token: string; playing: QueueItem; performer: string }) {
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
    <section className="card contest">
      <span className="label">🏆 Campeonato · sua nota</span>
      <p>
        O que você está achando de <strong>{performer}</strong>?
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
        <p className="muted small">{vote ? `${SCORE_LABELS[vote - 1]}! Dá para mudar até a música acabar.` : 'Toque em uma carinha. A votação fecha quando a música acabar.'}</p>
      )}
    </section>
  );
}

/** Quick reactions that float on the projector while someone sings. */
function ReactionBar({ token }: { token: string }) {
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
    <div className="reactbar" aria-label="Mandar reação para o telão">
      {msg && <span className="reactbar-msg">{msg}</span>}
      {REACTIONS.map((r, i) => (
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

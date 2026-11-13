'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import GifSheet from '@/components/GifSheet';
import Ranking from '@/components/Ranking';
import SongSearch from '@/components/SongSearch';
import Avatar from '@/components/Avatar';
import { browserClient } from '@/lib/supabase-browser';
import { del, get, post, put, useLive } from '@/lib/useLive';
import { selfieJpeg } from '@/lib/selfie';
import { cleanSongTitle, drawSticker, type StickerData } from '@/lib/sticker';
import { timeoutSignal } from '@/lib/timeout';
import { fmtScore, REACTIONS, SCORE_EMOJIS, SCORE_LABELS, scorePhrase, photoUrl, type QueueItem, type Reserve, type SearchResult, type Singer } from '@/lib/types';

const TOKEN_KEY = 'karaoke_token';
const LAST_SONG_KEY = 'karaoke_last_song';
const SELFIE_SKIP_KEY = 'karaoke_selfie_skip';

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

  const self = singers[me.id] ?? me;
  const playing = queue.find((q) => q.status === 'playing') ?? null;
  const line = queue.filter((q) => q.status === 'waiting' && singers[q.singer_id]?.status === 'approved');
  const entry = queue.find((q) => q.singer_id === me.id) ?? null;
  const ahead = entry?.status === 'waiting' ? line.findIndex((q) => q.id === entry.id) : -1;
  const maxDurationSec = settings?.max_duration_sec ?? 360;
  const open = settings?.queue_open ?? true;
  const contestOn = !!settings?.contest_id;
  const canInteract = self.status === 'approved';
  const rankingOn = !!settings?.ranking_enabled && !contestOn;
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
  const [lastSong, setLastSong] = useState<{ queueId: number; title: string; at: number; score: number | null } | null>(null);
  const [sticker, setSticker] = useState<StickerData | null>(null);
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
    const song = { queueId: was.id, title: was.title, at: Date.now(), score: null as number | null };
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

  if (!loaded) return <Loading />;

  return (
    <main className="phone">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">🍄</span>
          <strong>Karaokê Cogumelo</strong>
        </div>
        <span className="chip with-avatar">
          <Avatar src={myPhoto} size={22} />
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

      {lastSong && entry?.status !== 'playing' && (
        <section className="card sticker-ready">
          <span className="label">🎉 Mandou bem!</span>
          <p>
            {lastSong.score != null
              ? `A galera te deu ${fmtScore(lastSong.score)}. ${scorePhrase(lastSong.score)}`
              : 'Sua figurinha de quem cantou no Cogumelo tá pronta.'}
          </p>
          <div className="btns">
            <button
              className="btn primary"
              onClick={() => setSticker({ name: self.name, title: lastSong.title, score: lastSong.score, photo: myPhoto })}
            >
              Ver minha figurinha
            </button>
            <button className="btn ghost" onClick={forgetLastSong}>
              Agora não
            </button>
          </div>
        </section>
      )}

      {photosOn && self.status !== 'blocked' && <SelfieCard token={token} photo={myPhoto} onChange={refresh} />}

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

      {contestOn && playing && playing.singer_id === me.id && (
        <section className="card contest">
          <span className="label">🏆 Campeonato valendo</span>
          <p>A galera tá dando nota pra você agora. Capricha!</p>
        </section>
      )}
      {contestOn && playing && playing.singer_id !== me.id && canInteract && (
        <VoteCard token={token} playing={playing} performer={singers[playing.singer_id]?.name ?? 'quem tá cantando'} />
      )}
      {contestOn && !playing && (
        <p className="banner contest-banner">🏆 Campeonato valendo! Dá sua nota pra cada um enquanto canta.</p>
      )}

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
        <section>
          <h2 className="section-title">Quer deixar mais uma escolhida?</h2>
          <SongSearch authHeaders={{ 'x-singer-token': token }} maxDurationSec={maxDurationSec} pickLabel="Guardar" onPick={add} />
          <p className="muted small hint">
            Ela fica de reserva e entra no fim da fila depois que você cantar. Até {maxSongs} músicas por pessoa.
          </p>
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
          />
          <p className="muted small hint">
            Versão karaokê, de até {Math.floor(maxDurationSec / 60)} minutos. Uma música por vez, pra todo mundo cantar.
          </p>
        </section>
      )}

      {(playing || line.length > 0) && (
        <section className="card">
          <span className="label">A fila agora</span>
          <ol className="line">
            {playing && (
              <li className={playing.singer_id === me.id ? 'me' : ''}>
                <span className="pos live">♪</span>
                <Avatar src={photoOf(playing.singer_id)} size={34} />
                <div className="grow">
                  <strong>{singers[playing.singer_id]?.name ?? '…'}</strong>
                  <span className="muted small">{playing.title}</span>
                </div>
              </li>
            )}
            {line.slice(0, 15).map((q, i) => (
              <li key={q.id} className={q.singer_id === me.id ? 'me' : ''}>
                <span className="pos">{i + 1}</span>
                <Avatar src={photoOf(q.singer_id)} size={34} />
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
            unit="reactions"
            mine={(r) => r.singer_id === me.id}
            photo={(r) => (r.singer_id ? photoOf(r.singer_id) : null)}
            empty="Ninguém pontuou ainda. A nota sai das reações da galera no fim de cada música."
          />
          {myBest?.score != null && (
            <button className="btn" onClick={() => setSticker({ name: self.name, title: myBest.title, score: myBest.score, photo: myPhoto })}>
              Figurinha da minha nota
            </button>
          )}
          {ranking.length > 0 && <span className="muted small">Quanto mais gente reagir enquanto você canta, maior a nota.</span>}
        </section>
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
      {sticker && <StickerSheet data={sticker} onClose={() => setSticker(null)} />}
    </main>
  );
}

/** Optional selfie: shows on the projector next to the name, in the queue and in the ranking. */
function SelfieCard({ token, photo, onChange }: { token: string; photo: string | null; onChange: () => Promise<void> }) {
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
      await post('/api/photo', { jpeg }, { 'x-singer-token': token });
      await onChange();
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
      await onChange();
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

/** The "figurinha": an image with the name, the song and the crowd's grade, to share. */
function StickerSheet({ data, onClose }: { data: StickerData; onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let stop = false;
    let made: string | null = null;
    drawSticker(data)
      .then((blob) => {
        if (stop) return;
        const slug = cleanSongTitle(data.title).normalize('NFD').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40).toLowerCase();
        setFile(new File([blob], `cogumelo-${slug || 'karaoke'}.png`, { type: 'image/png' }));
        made = URL.createObjectURL(blob);
        setUrl(made);
      })
      .catch((e) => !stop && setErr((e as Error).message));
    return () => {
      stop = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [data]);

  const canShare = !!file && typeof navigator !== 'undefined' && !!navigator.canShare?.({ files: [file] });
  async function share() {
    if (!file) return;
    try {
      await navigator.share({ files: [file], text: 'Soltei a voz no karaokê do Cogumelo Bar! 🎤🍄' });
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setErr('Não deu pra compartilhar. Usa o botão de salvar.');
    }
  }

  return (
    <div className="sheet-back" onClick={onClose}>
      <div className="sheet sticker-sheet" role="dialog" aria-label="Sua figurinha" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <strong>Sua figurinha</strong>
          <button className="btn small icon-only ghost" aria-label="Fechar" onClick={onClose}>
            ✕
          </button>
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        {url ? <img className="sticker-img" src={url} alt="Figurinha com seu nome e sua nota" /> : !err && <span className="spinner big" />}
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
        </div>
        <span className="muted small">Posta no story e marca o Cogumelo! 🍄</span>
      </div>
    </div>
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

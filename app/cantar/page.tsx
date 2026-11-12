'use client';
import { useCallback, useEffect, useState } from 'react';
import { fmt, post } from '@/lib/useLive';
import type { SearchResult } from '@/lib/types';

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

interface Me {
  singer: { id: string; name: string; status: 'pending' | 'approved' | 'blocked' };
  entry: { id: number; title: string; thumbnail: string | null; status: 'waiting' | 'playing' } | null;
  ahead: number | null;
  maxDurationSec: number;
}

export default function SingPage() {
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    setToken(readToken());
    setReady(true);
  }, []);

  const loadMe = useCallback(async () => {
    if (!token) return;
    const res = await fetch('/api/me', { headers: { 'x-singer-token': token }, cache: 'no-store' });
    if (res.status === 404) {
      writeToken(null);
      setToken(null);
      setMe(null);
      return;
    }
    if (res.ok) setMe(await res.json());
  }, [token]);

  useEffect(() => {
    if (!token) return;
    loadMe();
    const t = setInterval(loadMe, 4000);
    return () => clearInterval(t);
  }, [token, loadMe]);

  if (!ready) return <main className="center">Carregando…</main>;
  if (!token) return <Join onJoined={(t) => (writeToken(t), setToken(t))} />;
  if (!me) return <main className="center">Carregando…</main>;

  return (
    <main className="phone">
      <header>
        <h1>🍄 Karaokê</h1>
        <span className="muted">Olá, {me.singer.name}!</span>
      </header>

      {me.singer.status === 'blocked' && <p className="card error">O admin não liberou você para cantar hoje.</p>}
      {me.singer.status === 'pending' && (
        <p className="card notice">⏳ Aguardando o admin aprovar sua entrada. Você já pode escolher a música!</p>
      )}

      {me.singer.status !== 'blocked' &&
        (me.entry ? (
          <MySong me={me} token={token} onChange={loadMe} />
        ) : (
          <Search token={token} maxDurationSec={me.maxDurationSec} onAdded={loadMe} />
        ))}
    </main>
  );
}

function Join({ onJoined }: { onJoined: (token: string) => void }) {
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
            onJoined(d.token);
          } catch (e) {
            setErr((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <h1>🍄 Karaokê Cogumelo</h1>
        <p>Como devemos te chamar no telão?</p>
        <input placeholder="Seu nome" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        {err && <p className="error">{err}</p>}
        <button className="btn primary" disabled={busy || !name.trim()}>
          Entrar na fila
        </button>
      </form>
    </main>
  );
}

function MySong({ me, token, onChange }: { me: Me; token: string; onChange: () => void }) {
  const e = me.entry!;
  return (
    <section className="card mysong">
      {e.thumbnail && <img src={e.thumbnail} alt="" />}
      <strong>{e.title}</strong>
      {e.status === 'playing' ? (
        <p className="big-msg">🎤 É a sua vez! Pega o microfone!</p>
      ) : me.singer.status === 'pending' ? (
        <p>Sua música entra na fila assim que o admin aprovar.</p>
      ) : me.ahead === 0 ? (
        <p className="big-msg">Você é o próximo! Prepare-se 🎶</p>
      ) : (
        <p>{me.ahead} pessoa(s) na sua frente.</p>
      )}
      {e.status === 'waiting' && (
        <button
          className="btn"
          onClick={async () => {
            if (!confirm('Tirar sua música da fila?')) return;
            await fetch('/api/queue', { method: 'DELETE', headers: { 'x-singer-token': token } });
            onChange();
          }}
        >
          Trocar / tirar música
        </button>
      )}
    </section>
  );
}

function Search({ token, maxDurationSec, onAdded }: { token: string; maxDurationSec: number; onAdded: () => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [adding, setAdding] = useState<string | null>(null);

  async function search(e?: React.FormEvent) {
    e?.preventDefault();
    if (q.trim().length < 2) return;
    setBusy(true);
    setErr('');
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { headers: { 'x-singer-token': token } });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error);
      setResults(d.results);
    } catch (e) {
      setErr((e as Error).message || 'Erro na busca');
    } finally {
      setBusy(false);
    }
  }

  async function add(r: SearchResult) {
    setAdding(r.videoId);
    setErr('');
    try {
      await post('/api/queue', r, { 'x-singer-token': token });
      onAdded();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setAdding(null);
    }
  }

  return (
    <section>
      <form className="searchbar" onSubmit={search}>
        <input placeholder="Música ou artista" value={q} onChange={(e) => setQ(e.target.value)} enterKeyHint="search" />
        <button className="btn primary" disabled={busy}>
          {busy ? '…' : 'Buscar'}
        </button>
      </form>
      <p className="muted small">Só versões karaokê de até {Math.floor(maxDurationSec / 60)} minutos. Uma música por vez.</p>
      {err && <p className="error">{err}</p>}
      {results && results.length === 0 && <p className="muted">Nada encontrado. Tente outro nome.</p>}
      <ul className="results">
        {results?.map((r) => (
          <li key={r.videoId}>
            <img src={r.thumbnail} alt="" loading="lazy" />
            <div>
              <strong>{r.title}</strong>
              <span className="muted small">
                {r.channel} · {fmt(r.durationSec)}
              </span>
            </div>
            <button className="btn primary" disabled={adding !== null} onClick={() => add(r)}>
              {adding === r.videoId ? '…' : 'Cantar'}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

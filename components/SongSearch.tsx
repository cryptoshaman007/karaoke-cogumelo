'use client';
import { useEffect, useRef, useState } from 'react';
import Icon from './Icon';
import { fmt } from '@/lib/useLive';
import type { PopularSong, SearchResult } from '@/lib/types';

interface Props {
  /** headers that identify who is searching (customer token); empty for the admin */
  authHeaders?: Record<string, string>;
  maxDurationSec: number;
  pickLabel: string;
  /** called when a song is chosen; may throw an Error with a message for the user */
  onPick: (song: SearchResult) => Promise<void>;
  disabled?: boolean;
  showPopular?: boolean;
}

export default function SongSearch({ authHeaders, maxDurationSec, pickLabel, onPick, disabled, showPopular }: Props) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [popular, setPopular] = useState<PopularSong[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [picking, setPicking] = useState<string | null>(null);
  const reqId = useRef(0);

  useEffect(() => {
    if (!showPopular) return;
    fetch('/api/popular')
      .then((r) => r.json())
      .then((d) => setPopular(Array.isArray(d.songs) ? d.songs : []))
      .catch(() => {});
  }, [showPopular]);

  async function search(e?: React.FormEvent) {
    e?.preventDefault();
    const term = q.trim();
    if (term.length < 2) return;
    const mine = ++reqId.current;
    setBusy(true);
    setErr('');
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(term)}`, { headers: authHeaders });
      const d = await res.json().catch(() => ({}));
      if (mine !== reqId.current) return;
      if (!res.ok) throw new Error(d.error ?? 'A busca falhou. Tente de novo.');
      setResults(d.results ?? []);
    } catch (e) {
      if (mine === reqId.current) setErr((e as Error).message || 'A busca falhou. Tente de novo.');
    } finally {
      if (mine === reqId.current) setBusy(false);
    }
  }

  async function pick(r: SearchResult) {
    setPicking(r.videoId);
    setErr('');
    try {
      await onPick(r);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setPicking(null);
    }
  }

  const fits = popular.filter((p) => p.durationSec <= maxDurationSec);
  const list: SearchResult[] | null = results ?? (showPopular && fits.length > 0 ? fits : null);

  return (
    <div className="search">
      <form className="searchbar" onSubmit={search} role="search">
        <input
          type="search"
          placeholder="Música ou artista"
          aria-label="Buscar música ou artista"
          value={q}
          maxLength={100}
          onChange={(e) => setQ(e.target.value)}
          enterKeyHint="search"
          autoComplete="off"
        />
        <button className="btn primary" disabled={busy || q.trim().length < 2} aria-label="Buscar">
          {busy ? <span className="spinner" /> : <Icon name="search" />}
        </button>
      </form>
      {err && <p className="error" role="alert">{err}</p>}
      {results && results.length === 0 && !busy && (
        <p className="muted empty">Nenhum karaokê encontrado. Tente o nome da música junto com o artista.</p>
      )}
      {!results && list && <h2 className="section-title">Mais cantadas no Cogumelo</h2>}
      {list && list.length > 0 && (
        <ul className="results">
          {list.map((r) => (
            <li key={r.videoId}>
              <img src={r.thumbnail} alt="" loading="lazy" width={96} height={54} />
              <div className="grow">
                <strong>{r.title}</strong>
                <span className="muted small">{[r.channel, fmt(r.durationSec)].filter(Boolean).join(' · ')}</span>
              </div>
              <button className="btn primary small" disabled={disabled || picking !== null} onClick={() => pick(r)}>
                {picking === r.videoId ? <span className="spinner" /> : pickLabel}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

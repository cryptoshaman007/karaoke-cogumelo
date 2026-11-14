'use client';
import { GATE_EVENT } from '@/lib/useLive';
import { useEffect, useRef, useState } from 'react';
import Icon from './Icon';
import { fmt } from '@/lib/useLive';
import { timeoutSignal } from '@/lib/timeout';
import type { PopularSong, SearchResult } from '@/lib/types';
import { youtubeIdFrom } from '@/lib/song';

interface Props {
  /** headers that identify who is searching (customer token); empty for the admin */
  authHeaders?: Record<string, string>;
  maxDurationSec: number;
  pickLabel: string;
  /** called when a song is chosen; may throw an Error with a message for the user */
  onPick: (song: SearchResult) => Promise<void>;
  disabled?: boolean;
  showPopular?: boolean;
  /** a search to run from outside (the suggestions at the end of the page); `n` changes on every tap */
  preset?: { text: string; n: number } | null;
}

const POPULAR_FIRST = 4;

export default function SongSearch({ authHeaders, maxDurationSec, pickLabel, onPick, disabled, showPopular, preset }: Props) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [popular, setPopular] = useState<PopularSong[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [picking, setPicking] = useState<string | null>(null);
  /** the last answer came from a pasted link; `karaoke` false = the title does not look like karaoke */
  const [link, setLink] = useState<{ karaoke: boolean } | null>(null);
  const [morePopular, setMorePopular] = useState(false);
  /** YouTube's search failed and the songs came from plan B ('history' = already sung at the bar) */
  const [fallback, setFallback] = useState<string | null>(null);
  const reqId = useRef(0);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showPopular) return;
    fetch('/api/popular')
      .then((r) => r.json())
      .then((d) => setPopular(Array.isArray(d.songs) ? d.songs : []))
      .catch(() => {});
  }, [showPopular]);

  // a suggestion was tapped: fill in the search, run it and bring it into view
  const presetSeen = useRef(preset?.n);
  useEffect(() => {
    if (!preset || presetSeen.current === preset.n) return;
    presetSeen.current = preset.n;
    setQ(preset.text);
    void search(undefined, preset.text);
    box.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset?.n]);

  async function search(e?: React.FormEvent, text?: string) {
    e?.preventDefault();
    const term = (text ?? q).trim();
    if (term.length < 2) return;
    const mine = ++reqId.current;
    setBusy(true);
    setErr('');
    setLink(null);
    setFallback(null);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(term)}`, { headers: authHeaders, signal: timeoutSignal(24000) });
      const d = await res.json().catch(() => ({}));
      if (mine !== reqId.current) return;
      if (res.status === 403 && d.gate) window.dispatchEvent(new CustomEvent(GATE_EVENT, { detail: d.gate }));
      if (!res.ok) throw new Error(d.error ?? 'A busca falhou. Tenta de novo.');
      setResults(d.results ?? []);
      if (d.fromLink) setLink({ karaoke: !!d.karaoke });
      if (typeof d.fallback === 'string') setFallback(d.fallback);
    } catch (e) {
      const name = (e as Error).name;
      const msg = name === 'TimeoutError' || name === 'AbortError' || e instanceof TypeError ? 'A busca demorou demais. Tenta de novo.' : (e as Error).message;
      if (mine === reqId.current) setErr(msg || 'A busca falhou. Tenta de novo.');
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
  const popularShown = morePopular ? fits : fits.slice(0, POPULAR_FIRST);
  const list: SearchResult[] | null = results ?? (showPopular && fits.length > 0 ? popularShown : null);

  return (
    <div className="search" ref={box}>
      <form className="searchbar" onSubmit={search} role="search">
        <input
          type="search"
          placeholder="Música, artista ou link YT"
          aria-label="Buscar música, artista ou colar link do YouTube"
          value={q}
          maxLength={100}
          onChange={(e) => setQ(e.target.value)}
          onPaste={(e) => {
            // a pasted YouTube link goes straight to the result, no need to press the button
            const text = e.clipboardData.getData('text');
            if (youtubeIdFrom(text)) {
              e.preventDefault();
              setQ(text.trim());
              void search(undefined, text);
            }
          }}
          enterKeyHint="search"
          autoComplete="off"
        />
        <button className="btn primary" disabled={busy || q.trim().length < 2} aria-label="Buscar">
          {busy ? <span className="spinner" /> : <Icon name="search" />}
        </button>
      </form>
      {err && <p className="error" role="alert">{err}</p>}
      {fallback === 'history' && results && !busy && (
        <p className="banner warn small">
          A busca do YouTube deu uma engasgada agora. {results.length > 0 ? 'Achei essas que já cantaram aqui no Cogumelo. ' : ''}
          Tenta de novo daqui a pouco, ou procura o karaokê no YouTube, copia o link e cola aqui em cima.
        </p>
      )}
      {results && results.length === 0 && !busy && fallback !== 'history' && (
        <p className="muted empty">
          Não achei karaokê disso. Tenta o nome da música junto com o artista, ou procura o karaokê no YouTube, copia o link e cola
          aqui em cima.
        </p>
      )}
      {link && !link.karaoke && results && results.length > 0 && (
        <p className="banner warn small">Esse vídeo não parece versão karaokê: pode ter a voz do cantor original. Confere antes de escolher.</p>
      )}
      {!results && !busy && <p className="muted small link-tip">Não achou? Procura o karaokê no YouTube, copia o link e cola aqui.</p>}
      {!results && list && <h2 className="section-title">Mais cantadas do Cogumelo</h2>}
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
      {!results && list && fits.length > POPULAR_FIRST && (
        <button type="button" className="btn ghost small self-start" onClick={() => setMorePopular((m) => !m)}>
          {morePopular ? 'Ver menos' : `Ver mais (${fits.length - POPULAR_FIRST})`}
        </button>
      )}
    </div>
  );
}

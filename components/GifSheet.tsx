'use client';
import { useEffect, useRef, useState } from 'react';
import Icon from './Icon';
import { get, post } from '@/lib/useLive';
import { PRESET_GIFS, presetGifPreview, STICKERS, type GifResult } from '@/lib/types';

/** Bottom sheet on the phone: pick a sticker, one of the hand-picked GIFs, or search a GIF to throw on the projector. */
export default function GifSheet({ token, onClose, onSent }: { token: string; onClose: () => void; onSent: () => void }) {
  const headers = { 'x-singer-token': token };
  const [canSearch, setCanSearch] = useState(false);
  const [gifs, setGifs] = useState<GifResult[]>([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState('');
  const reqId = useRef(0);
  // hand-picked GIFs whose picture did not load (removed from GIPHY, no internet): hidden
  const [brokenPresets, setBrokenPresets] = useState<string[]>([]);

  async function load(term: string) {
    const mine = ++reqId.current;
    setBusy(true);
    setErr('');
    try {
      const d = await get(`/api/gif${term ? `?q=${encodeURIComponent(term)}` : ''}`, headers);
      if (mine !== reqId.current) return;
      setCanSearch(!!d.search);
      setGifs(Array.isArray(d.results) ? d.results : []);
    } catch (e) {
      // the stickers still work without the search
      if (mine === reqId.current && term) setErr((e as Error).message);
    } finally {
      if (mine === reqId.current) setBusy(false);
    }
  }

  useEffect(() => {
    void load('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function send(body: { sticker: string } | { gif: string } | { preset: string }) {
    if (sending) return;
    setSending(true);
    setErr('');
    try {
      await post('/api/gif', body, headers);
      try {
        navigator.vibrate?.(15);
      } catch {}
      onSent();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="sheet-back" onClick={onClose}>
      <div className="sheet gif-sheet" role="dialog" aria-label="Mandar GIF pro telão" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <strong>Manda no telão</strong>
          <button className="btn ghost small" onClick={onClose}>
            Fechar
          </button>
        </div>
        {err && <p className="error" role="alert">{err}</p>}
        <div className="sticker-grid">
          {STICKERS.map((s) => (
            <button key={s.key} disabled={sending} onClick={() => send({ sticker: s.key })}>
              <span>{s.emoji}</span>
              {s.text}
            </button>
          ))}
        </div>
        <span className="muted small">GIFs</span>
        <div className="gif-grid presets" aria-label="GIFs prontos">
          {PRESET_GIFS.filter((g) => !brokenPresets.includes(g.id)).map((g) => (
            <button key={g.id} disabled={sending} aria-label={g.title} title={g.title} onClick={() => send({ preset: g.id })}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={presetGifPreview(g.id)} alt="" loading="lazy" onError={() => setBrokenPresets((b) => (b.includes(g.id) ? b : [...b, g.id]))} />
            </button>
          ))}
        </div>
        {canSearch && (
          <>
            <form
              className="searchbar"
              role="search"
              onSubmit={(e) => {
                e.preventDefault();
                void load(q.trim());
              }}
            >
              <input
                type="search"
                placeholder="Buscar GIF"
                aria-label="Buscar GIF"
                value={q}
                maxLength={50}
                onChange={(e) => setQ(e.target.value)}
                enterKeyHint="search"
                autoComplete="off"
              />
              <button className="btn primary" disabled={busy} aria-label="Buscar GIF">
                {busy ? <span className="spinner" /> : <Icon name="search" />}
              </button>
            </form>
            {gifs.length === 0 && !busy && q.trim() !== '' && <p className="muted small">Nenhum GIF por aqui. Tenta outra palavra.</p>}
            <div className="gif-grid">
              {gifs.map((g) => (
                <button key={g.id} disabled={sending} aria-label={g.title || 'GIF'} onClick={() => send({ gif: g.id })}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={g.preview} alt="" loading="lazy" onError={(e) => ((e.currentTarget.parentElement as HTMLElement).style.display = 'none')} />
                </button>
              ))}
            </div>
          </>
        )}
        <span className="muted small">GIFs por GIPHY</span>
      </div>
    </div>
  );
}

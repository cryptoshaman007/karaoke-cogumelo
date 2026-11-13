'use client';
import { useEffect, useRef, useState } from 'react';
import AdminLogin from '@/components/AdminLogin';
import { useAdmin } from '@/lib/useAdmin';
import Icon from '@/components/Icon';
import Ranking from '@/components/Ranking';
import SongSearch from '@/components/SongSearch';
import { fmt, get, post, useLive, type ApiError } from '@/lib/useLive';
import type { SearchResult, Standing } from '@/lib/types';

export default function AdminPage() {
  const [admin, setAdmin] = useAdmin();
  if (admin === null)
    return (
      <main className="center">
        <span className="spinner big" aria-label="Carregando" />
      </main>
    );
  if (!admin) return <AdminLogin title="Painel do admin" onOk={() => setAdmin(true)} />;
  return <Panel onLogout={() => setAdmin(false)} />;
}

function Panel({ onLogout }: { onLogout: () => void }) {
  const { queue, singers, settings, results, loaded, refresh } = useLive({ admin: true });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [minutes, setMinutes] = useState('');
  const [gap, setGap] = useState('');
  const [message, setMessage] = useState('');
  const [volume, setVolume] = useState<number | null>(null);
  const [addName, setAddName] = useState('');
  const [added, setAdded] = useState('');
  const [standings, setStandings] = useState<Standing[]>([]);
  const filled = useRef(false);
  const volTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // fill the form once with what is saved
  useEffect(() => {
    if (!settings || filled.current) return;
    filled.current = true;
    setMinutes(String(settings.max_duration_sec / 60));
    setGap(String(settings.intermission_sec));
    setMessage(settings.tv_message);
  }, [settings]);

  // partial ranking while a contest runs: refreshed every few seconds and when the song changes
  const contestId = settings?.contest_id ?? null;
  const playingId = queue.find((q) => q.status === 'playing')?.id ?? null;
  useEffect(() => {
    if (!contestId) return setStandings([]);
    let stop = false;
    const load = () =>
      document.visibilityState === 'visible' &&
      get('/api/admin/contest')
        .then((d) => !stop && setStandings(d.standings ?? []))
        .catch(() => {});
    load();
    const t = setInterval(load, 8000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [contestId, playingId]);

  async function act(url: string, body: unknown) {
    setErr('');
    setBusy(true);
    try {
      await post(url, body);
      await refresh();
      return true;
    } catch (e) {
      const msg = (e as Error).message;
      setErr(msg);
      if ((e as ApiError).status === 401) onLogout();
      return false;
    } finally {
      setBusy(false);
    }
  }
  const setting = (body: unknown) => act('/api/admin/settings', body);
  const contest = (action: 'start' | 'end' | 'hide') => act('/api/admin/contest', { action });
  const queueAct = (body: unknown) => act('/api/admin/queue', body);

  function changeVolume(v: number) {
    setVolume(v);
    if (volTimer.current) clearTimeout(volTimer.current);
    volTimer.current = setTimeout(async () => {
      await setting({ volume: v });
      setVolume(null);
    }, 350);
  }

  async function addForSomeone(song: SearchResult) {
    const name = addName.trim();
    if (!name) throw new Error('Digite o nome da pessoa primeiro');
    await post('/api/admin/queue', { action: 'add', name, song });
    setAdded(`${name} entrou na fila.`);
    setAddName('');
    await refresh();
  }

  if (!loaded || !settings)
    return (
      <main className="center">
        <span className="spinner big" aria-label="Carregando" />
      </main>
    );

  const playing = queue.find((q) => q.status === 'playing');
  const waiting = queue.filter((q) => q.status === 'waiting');
  const all = Object.values(singers);
  const pending = all.filter((s) => s.status === 'pending');
  const blocked = all.filter((s) => s.status === 'blocked');
  const songOf = (singerId: string) => waiting.find((q) => q.singer_id === singerId);
  const vol = volume ?? settings.volume;

  return (
    <main className="phone admin">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">🍄</span>
          <strong>Admin</strong>
        </div>
        <button className="btn ghost small" onClick={async () => (await post('/api/admin/logout', {}).catch(() => {}), onLogout())}>
          Sair
        </button>
      </header>
      {err && <p className="banner danger" role="alert">{err}</p>}

      {pending.length > 0 && (
        <section className="card attention">
          <h2>
            Aguardando aprovação <span className="count-pill">{pending.length}</span>
          </h2>
          <ul className="rows">
            {pending.map((s) => (
              <li key={s.id}>
                <div className="grow">
                  <strong>{s.name}</strong>
                  <span className="muted small">{songOf(s.id)?.title ?? 'ainda sem música'}</span>
                </div>
                <button className="btn primary small" disabled={busy} onClick={() => act('/api/admin/singers', { id: s.id, status: 'approved' })}>
                  <Icon name="check" /> Aprovar
                </button>
                <button
                  className="btn danger small icon-only"
                  aria-label={`Recusar ${s.name}`}
                  disabled={busy}
                  onClick={() => act('/api/admin/singers', { id: s.id, status: 'blocked' })}
                >
                  <Icon name="close" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <h2>Tocando agora</h2>
        {playing ? (
          <>
            <div className="nowrow">
              {playing.thumbnail && <img src={playing.thumbnail} alt="" width={96} height={54} />}
              <div className="grow">
                <strong>{singers[playing.singer_id]?.name}</strong>
                <span className="muted small">
                  {playing.title} · {fmt(playing.duration_sec)}
                </span>
              </div>
            </div>
            <div className="controls">
              <button className="btn" disabled={busy} onClick={() => setting({ paused: !settings.paused })}>
                <Icon name={settings.paused ? 'play' : 'pause'} /> {settings.paused ? 'Continuar' : 'Pausar'}
              </button>
              <button className="btn" disabled={busy} onClick={() => setting({ restart: true })}>
                <Icon name="restart" /> Reiniciar
              </button>
              <button className="btn" disabled={busy} onClick={() => queueAct({ action: 'skip', id: playing.id })}>
                <Icon name="skip" /> Pular
              </button>
            </div>
          </>
        ) : (
          <p className="muted">Nada tocando.</p>
        )}
        <label className="slider">
          <Icon name="volume" />
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={vol}
            aria-label="Volume do telão"
            onChange={(e) => changeVolume(Number(e.target.value))}
          />
          <span className="muted small">{vol}%</span>
        </label>
      </section>

      <section className="card">
        <h2>
          Fila <span className="count-pill muted-pill">{waiting.length}</span>
        </h2>
        {waiting.length === 0 && <p className="muted">Ninguém na fila.</p>}
        <ul className="rows">
          {waiting.map((q, i) => {
            const s = singers[q.singer_id];
            return (
              <li key={q.id} className={s?.status !== 'approved' ? 'qrow dim' : 'qrow'}>
                <span className="pos">{i + 1}</span>
                <div className="grow">
                  <strong>
                    {s?.name ?? '…'} {s?.status === 'pending' && <em className="tag">aguardando</em>}
                  </strong>
                  <span className="muted small">
                    {q.title} · {fmt(q.duration_sec)}
                  </span>
                </div>
                <div className="rowbtns">
                  <button
                    className="btn small icon-only"
                    aria-label="Tocar em seguida"
                    title="Tocar em seguida"
                    disabled={busy || i === 0}
                    onClick={() => queueAct({ action: 'top', id: q.id })}
                  >
                    <Icon name="top" />
                  </button>
                  <button
                    className="btn small icon-only"
                    aria-label="Subir"
                    disabled={busy || i === 0}
                    onClick={() => queueAct({ action: 'up', id: q.id })}
                  >
                    <Icon name="up" />
                  </button>
                  <button
                    className="btn small icon-only"
                    aria-label="Descer"
                    disabled={busy || i === waiting.length - 1}
                    onClick={() => queueAct({ action: 'down', id: q.id })}
                  >
                    <Icon name="down" />
                  </button>
                  <button
                    className="btn small icon-only danger"
                    aria-label="Tirar da fila"
                    disabled={busy}
                    onClick={() => queueAct({ action: 'remove', id: q.id })}
                  >
                    <Icon name="close" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
        {waiting.length > 1 && (
          <button className="btn danger small self-start" onClick={() => confirm('Limpar a fila inteira?') && queueAct({ action: 'clear' })}>
            Limpar fila
          </button>
        )}
      </section>

      <section className={`card ${settings.contest_id ? 'contest' : ''}`}>
        <h2>🏆 Campeonato {settings.contest_id && <span className="count-pill">valendo</span>}</h2>
        {settings.contest_id ? (
          <>
            <p className="muted small">
              Todo mundo dá nota de 1 a 5 pelo celular enquanto cada pessoa canta. Parcial (só você vê):
            </p>
            <Ranking rows={standings} />
            <button
              className="btn primary"
              disabled={busy}
              onClick={() => confirm('Encerrar o campeonato e mostrar o vencedor no telão?') && contest('end')}
            >
              Encerrar e mostrar o vencedor
            </button>
          </>
        ) : results ? (
          <>
            <p className="muted small">Resultado final. Está aparecendo no telão e nos celulares.</p>
            <Ranking rows={results} highlightFirst />
            <div className="row">
              <button className="btn" disabled={busy} onClick={() => contest('hide')}>
                Tirar do telão
              </button>
              <button className="btn" disabled={busy} onClick={() => contest('start')}>
                Novo campeonato
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="muted small">
              Ao ligar, cada cliente dá uma nota (5 carinhas) para quem está cantando. Quando você encerrar, o telão mostra
              a classificação e o vencedor.
            </p>
            <button className="btn self-start" disabled={busy} onClick={() => contest('start')}>
              Iniciar campeonato
            </button>
          </>
        )}
      </section>

      <details className="card fold">
        <summary>
          <div className="grow">
            <h2>Colocar alguém na fila</h2>
            <span className="muted small">Para quem está sem celular</span>
          </div>
        </summary>
        <label className="field">
          <span>Nome da pessoa</span>
          <input
            placeholder="Nome"
            maxLength={40}
            value={addName}
            onChange={(e) => (setAddName(e.target.value), setAdded(''))}
          />
        </label>
        {added && <p className="ok">{added}</p>}
        <SongSearch maxDurationSec={settings.max_duration_sec} pickLabel="Adicionar" onPick={addForSomeone} />
      </details>

      <section className="card">
        <h2>Configurações</h2>
        <label className="switch">
          <input type="checkbox" checked={settings.queue_open} onChange={(e) => setting({ queueOpen: e.target.checked })} />
          <span>
            <strong>Fila aberta</strong>
            <span className="muted small">Desligue no fim da noite para ninguém mais entrar.</span>
          </span>
        </label>
        <label className="switch">
          <input type="checkbox" checked={settings.require_approval} onChange={(e) => setting({ requireApproval: e.target.checked })} />
          <span>
            <strong>Aprovar pessoas novas</strong>
            <span className="muted small">Quem já foi aprovado uma vez não precisa de novo.</span>
          </span>
        </label>
        <label className="switch">
          <input type="checkbox" checked={settings.reactions_enabled} onChange={(e) => setting({ reactionsEnabled: e.target.checked })} />
          <span>
            <strong>Reações no telão</strong>
            <span className="muted small">Palmas, coração, fogo e choro enviados pelo celular.</span>
          </span>
        </label>
        <label className="switch">
          <input type="checkbox" checked={settings.tv_add_enabled} onChange={(e) => setting({ tvAddEnabled: e.target.checked })} />
          <span>
            <strong>Adicionar pedido pelo telão</strong>
            <span className="muted small">Mostra um botão “+” discreto no computador, para quem está sem celular.</span>
          </span>
        </label>
        <div className="field">
          <span>Músicas por pessoa</span>
          <div className="row">
            {[1, 2, 3].map((n) => (
              <button
                key={n}
                className={settings.songs_per_person === n ? 'btn primary' : 'btn'}
                aria-pressed={settings.songs_per_person === n}
                disabled={busy}
                onClick={() => setting({ songsPerPerson: n })}
              >
                {n}
              </button>
            ))}
          </div>
          <span className="muted small">
            Ninguém canta duas seguidas: só uma fica na fila. As outras ficam de reserva e entram no fim da fila quando a pessoa termina de cantar.
          </span>
        </div>
        <div className="field">
          <span>Duração máxima da música (minutos)</span>
          <div className="row">
            <input type="number" inputMode="decimal" min={1} max={30} step={0.5} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
            <button className="btn" disabled={busy || minutes === ''} onClick={() => setting({ maxDurationMin: Number(minutes) })}>
              Salvar
            </button>
          </div>
        </div>
        <div className="field">
          <span>Tempo de “próximo cantor” no telão (segundos)</span>
          <div className="row">
            <input type="number" inputMode="numeric" min={0} max={30} step={1} value={gap} onChange={(e) => setGap(e.target.value)} />
            <button className="btn" disabled={busy || gap === ''} onClick={() => setting({ intermissionSec: Number(gap) })}>
              Salvar
            </button>
          </div>
        </div>
        <div className="field">
          <span>Recado no telão</span>
          <div className="row">
            <input
              className="wide"
              placeholder="Ex.: Caipirinha em dobro até 22h"
              maxLength={140}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
            <button className="btn" disabled={busy} onClick={() => setting({ tvMessage: message })}>
              Salvar
            </button>
          </div>
        </div>
      </section>

      {blocked.length > 0 && (
        <details className="card fold">
          <summary>
            <h2>
              Recusados <span className="count-pill muted-pill">{blocked.length}</span>
            </h2>
          </summary>
          <ul className="rows">
            {blocked.map((s) => (
              <li key={s.id}>
                <strong className="grow">{s.name}</strong>
                <button className="btn small" disabled={busy} onClick={() => act('/api/admin/singers', { id: s.id, status: 'approved' })}>
                  Liberar
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </main>
  );
}

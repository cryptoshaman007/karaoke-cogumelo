'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import AdminLogin from '@/components/AdminLogin';
import { useAdmin } from '@/lib/useAdmin';
import Icon from '@/components/Icon';
import Avatar from '@/components/Avatar';
import Ranking from '@/components/Ranking';
import SongSearch from '@/components/SongSearch';
import { fmt, get, post, useLive, type ApiError } from '@/lib/useLive';
import { photoUrl, type SearchResult, type Singer, type Standing } from '@/lib/types';
import { looksKaraoke } from '@/lib/song';

const nameKey = (n: string) => n.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();

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
  const { queue, singers, settings, results, ranking, loaded, refresh } = useLive({ admin: true });
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
  // people refused on earlier nights (the live data only brings the last 24 hours)
  const [oldBlocked, setOldBlocked] = useState<Singer[]>([]);
  const loadBlocked = useCallback(() => {
    get('/api/admin/singers')
      .then((d) => setOldBlocked(Array.isArray(d?.singers) ? d.singers : []))
      .catch(() => {});
  }, []);
  useEffect(() => {
    loadBlocked();
    const t = setInterval(loadBlocked, 60000);
    return () => clearInterval(t);
  }, [loadBlocked]);
  const volTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // is the projector on, and does it have the Chrome extension? (null = unknown / database not updated)
  const [tv, setTv] = useState<{ tvSeenAt: string | null; extVersion: string | null; extSeenAt: string | null } | null>(null);
  useEffect(() => {
    const load = () =>
      get('/api/tv')
        .then((d) => setTv(d?.status ?? null))
        .catch(() => {});
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, []);

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
      if (url === '/api/admin/singers') loadBlocked();
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

  async function resetNight() {
    if (!confirm('Zerar a noite? Sai todo mundo da fila (inclusive quem tá cantando) e o ranking da noite começa do zero.')) return;
    if (await act('/api/night', { action: 'reset' })) setAdded('');
  }

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
    if (!name) throw new Error('Põe o nome da pessoa primeiro');
    await post('/api/admin/queue', { action: 'add', name, song });
    setAdded(`${name} tá na fila!`);
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
  const blocked = [
    ...all.filter((s) => s.status === 'blocked'),
    ...oldBlocked.filter((s) => !singers[s.id]),
  ].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const withPhoto = settings.photos_enabled ? all.filter((s) => s.status !== 'blocked' && s.photo_at) : [];
  const songOf = (singerId: string) => waiting.find((q) => q.singer_id === singerId);
  // a name already used tonight by someone else: maybe the same person on another phone (or a refused one back)
  const nameCount = new Map<string, number>();
  for (const s of all) nameCount.set(nameKey(s.name), (nameCount.get(nameKey(s.name)) ?? 0) + 1);
  const repeated = (name: string) => (nameCount.get(nameKey(name)) ?? 0) > 1;
  const holding = (settings.results_contest_id != null || (settings.ranking_enabled && settings.ranking_on_tv)) && waiting.length > 0;

  function refuse(id: string, name: string) {
    if (!confirm(`Recusar ${name}? A música e as reservas dessa pessoa saem da fila e não voltam se você liberar depois.`)) return;
    void act('/api/admin/singers', { id, status: 'blocked' });
  }
  function removeFromQueue(id: number, name: string) {
    if (!confirm(`Tirar ${name} da fila?`)) return;
    void queueAct({ action: 'remove', id });
  }
  function refuseAll() {
    if (!confirm(`Recusar as ${pending.length} pessoas que estão esperando ok? Use quando entrar um monte de nome falso.`)) return;
    void act('/api/admin/singers', { action: 'refuseAllPending', ids: pending.map((s) => s.id) });
  }
  async function logoutAll() {
    if (!confirm('Sair de todos os aparelhos? O telão também vai pedir a senha de novo. Use se perdeu um celular que tava logado.')) return;
    await post('/api/admin/logout', { all: true }).catch(() => {});
    onLogout();
  }
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
            Esperando seu ok <span className="count-pill">{pending.length}</span>
          </h2>
          {pending.length > 3 && (
            <button className="btn danger small self-start" disabled={busy} onClick={refuseAll}>
              Recusar todos
            </button>
          )}
          <ul className="rows">
            {pending.map((s) => (
              <li key={s.id}>
                <Avatar src={photoUrl(s, settings)} seed={s.id} size={40} />
                <div className="grow">
                  <strong>
                    {s.name} {repeated(s.name) && <em className="tag warn-tag">nome repetido</em>}
                  </strong>
                  <span className="muted small">{songOf(s.id)?.title ?? 'ainda escolhendo a música'}</span>
                </div>
                <button className="btn primary small" disabled={busy} onClick={() => act('/api/admin/singers', { id: s.id, status: 'approved' })}>
                  <Icon name="check" /> Aprovar
                </button>
                <button
                  className="btn danger small icon-only"
                  aria-label={`Recusar ${s.name}`}
                  disabled={busy}
                  onClick={() => refuse(s.id, s.name)}
                >
                  <Icon name="close" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <h2>No palco agora</h2>
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
                <Icon name="restart" /> Do início
              </button>
              <button className="btn" disabled={busy} onClick={() => queueAct({ action: 'skip', id: playing.id })}>
                <Icon name="skip" /> Pular
              </button>
            </div>
          </>
        ) : (
          <p className="muted">Palco vazio por enquanto.</p>
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

      <details className="card fold add-someone">
        <summary>
          <div className="grow">
            <h2>➕ Pôr alguém na fila</h2>
            <span className="muted small">Pra quem tá sem celular: digita o nome e escolhe a música</span>
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
        <h2>
          Fila <span className="count-pill muted-pill">{waiting.length}</span>
        </h2>
        {waiting.length === 0 && <p className="muted">Ninguém na fila. Chama a galera!</p>}
        <ul className="rows">
          {waiting.map((q, i) => {
            const s = singers[q.singer_id];
            return (
              <li key={q.id} className={s?.status !== 'approved' ? 'qrow dim' : 'qrow'}>
                <span className="pos">{i + 1}</span>
                <div className="grow">
                  <strong>
                    {s?.name ?? '…'} {s?.status === 'pending' && <em className="tag">esperando ok</em>}{' '}
                    {!looksKaraoke(q.title) && (
                      <em className="tag warn-tag" title="O título não parece versão karaokê: pode ter a voz do cantor original">
                        não parece karaokê
                      </em>
                    )}
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
                    onClick={() => removeFromQueue(q.id, s?.name ?? 'essa pessoa')}
                  >
                    <Icon name="close" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
        <div className="row">
          {waiting.length > 1 && (
            <button className="btn danger small" disabled={busy} onClick={() => confirm('Tirar todo mundo que tá esperando na fila?') && queueAct({ action: 'clear' })}>
              Limpar a fila
            </button>
          )}
          <button className="btn danger small" disabled={busy} onClick={resetNight}>
            Zerar a noite
          </button>
        </div>
        <span className="muted small">
          “Zerar a noite” é pro fim do expediente: limpa a fila toda e recomeça o ranking.
          {settings.night_reset_hour >= 0
            ? ` Se esquecer, a limpeza automática das ${settings.night_reset_hour}h resolve.`
            : ' A limpeza automática tá desligada (liga ali nas configurações).'}
        </span>
      </section>

      <h2 className="group-title">Diversão</h2>
      <section className="card">
        <h2>⭐ Ranking da noite {settings.ranking_enabled && <span className="count-pill muted-pill">ligado</span>}</h2>
        <label className="switch">
          <input type="checkbox" checked={settings.ranking_enabled} onChange={(e) => setting({ rankingEnabled: e.target.checked })} />
          <span>
            <strong>Nota no fim de cada música</strong>
            <span className="muted small">
              Vale a noite toda. Enquanto alguém canta, a galera escolhe uma das 5 carinhas no celular (igual ao campeonato). A nota de 0 a 10 é a média delas e aparece no telão quando a música acaba.
            </span>
          </span>
        </label>
        {settings.ranking_enabled && (
          <>
            {settings.contest_id && <p className="muted small">Pausado enquanto o campeonato tá valendo (lá o que conta são os votos).</p>}
            {settings.ranking_on_tv && holding && (
              <p className="banner warn">Tem gente esperando pra cantar: o telão fecha o ranking sozinho em 3 minutos.</p>
            )}
            <label className="switch">
              <input type="checkbox" checked={settings.leader_on_tv} onChange={(e) => setting({ leaderOnTv: e.target.checked })} />
              <span>
                <strong>Mostrar o líder da noite no telão</strong>
                <span className="muted small">A faixa “⭐ Líder da noite” no canto da tela do karaokê, com o convite pra dar nota.</span>
              </span>
            </label>
            <Ranking rows={ranking} limit={10} highlightFirst empty="Ninguém pontuou ainda nessa noite." />
            <button className="btn self-start" disabled={busy} onClick={() => setting({ rankingOnTv: !settings.ranking_on_tv })}>
              {settings.ranking_on_tv ? 'Tirar o ranking do telão' : 'Mostrar o ranking no telão'}
            </button>
          </>
        )}
      </section>

      <section className={`card ${settings.contest_id ? 'contest' : ''}`}>
        <h2>🏆 Campeonato {settings.contest_id && <span className="count-pill">valendo</span>}</h2>
        {settings.contest_id ? (
          <>
            <p className="muted small">
              Todo mundo dá nota de 1 a 5 pelo celular enquanto cada um canta. Parcial (só você vê):
            </p>
            <Ranking rows={standings} />
            <button
              className="btn primary"
              disabled={busy}
              onClick={() => confirm('Encerrar o campeonato e mostrar quem ganhou no telão?') && contest('end')}
            >
              Encerrar e mostrar quem ganhou
            </button>
          </>
        ) : results ? (
          <>
            <p className="muted small">Resultado final. Tá aparecendo no telão e nos celulares.</p>
            {holding && <p className="banner warn">Tem gente esperando pra cantar: o telão tira o resultado sozinho em 3 minutos.</p>}
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
              Pra concurso de verdade, por um período curto: você inicia, cada cliente dá uma nota (5 carinhas) pra quem
              tá cantando e, quando você encerrar, o telão mostra a classificação e quem ganhou. Enquanto vale, o ranking
              da noite fica pausado.
            </p>
            <button className="btn self-start" disabled={busy} onClick={() => contest('start')}>
              Iniciar campeonato
            </button>
          </>
        )}
      </section>

      <h2 className="group-title">Ajustes</h2>
      <section className="card">
        <h2>Fila e músicas</h2>
        <label className="switch">
          <input type="checkbox" checked={settings.queue_open} onChange={(e) => setting({ queueOpen: e.target.checked })} />
          <span>
            <strong>Fila aberta</strong>
            <span className="muted small">Desliga no fim da noite pra ninguém mais entrar.</span>
          </span>
        </label>
        <label className="switch">
          <input type="checkbox" checked={settings.require_approval} onChange={(e) => setting({ requireApproval: e.target.checked })} />
          <span>
            <strong>Aprovar gente nova</strong>
            <span className="muted small">Quem você já aprovou uma vez não precisa de novo.</span>
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
          <span>Contagem de “agora é com você” no telão (segundos)</span>
          <div className="row">
            <input type="number" inputMode="numeric" min={0} max={30} step={1} value={gap} onChange={(e) => setGap(e.target.value)} />
            <button className="btn" disabled={busy || gap === ''} onClick={() => setting({ intermissionSec: Number(gap) })}>
              Salvar
            </button>
          </div>
        </div>
        <div className="field">
          <span>Limpeza automática da fila (pra não sobrar pedido da noite passada)</span>
          <select
            className="select"
            aria-label="Limpeza automática da fila"
            value={settings.night_reset_hour}
            disabled={busy}
            onChange={(e) => setting({ nightResetHour: Number(e.target.value) })}
          >
            <option value={-1}>Desligada</option>
            {[4, 6, 8, 10, 12, 14, 16].map((h) => (
              <option key={h} value={h}>
                Todo dia às {h}h
              </option>
            ))}
            {![-1, 4, 6, 8, 10, 12, 14, 16].includes(settings.night_reset_hour) && (
              <option value={settings.night_reset_hour}>Todo dia às {settings.night_reset_hour}h</option>
            )}
          </select>
          <span className="small">Só limpa se ninguém cantou nem pediu música nos últimos 45 minutos, então nunca corta a festa no meio.</span>
        </div>
      </section>

      <section className="card">
        <h2>Telão e celular</h2>
        <label className="switch">
          <input type="checkbox" checked={settings.reactions_enabled} onChange={(e) => setting({ reactionsEnabled: e.target.checked })} />
          <span>
            <strong>Reações no telão</strong>
            <span className="muted small">Palmas, coração, fogo e choro mandados pelo celular. Só festa: não mudam a nota.</span>
          </span>
        </label>
        <label className="switch">
          <input type="checkbox" checked={settings.gifs_enabled} onChange={(e) => setting({ gifsEnabled: e.target.checked })} />
          <span>
            <strong>GIFs e figurinhas no telão</strong>
            <span className="muted small">A galera manda pelo celular e aparece num cantinho do vídeo. Um por pessoa a cada 12 segundos.</span>
          </span>
        </label>
        <label className="switch">
          <input type="checkbox" checked={settings.photos_enabled} onChange={(e) => setting({ photosEnabled: e.target.checked })} />
          <span>
            <strong>Selfie de quem canta</strong>
            <span className="muted small">Foto opcional que aparece no telão, na fila, no ranking e na figurinha da nota. Some no fim da noite.</span>
          </span>
        </label>
        <label className="switch">
          <input
            type="checkbox"
            checked={settings.yt_extension !== false}
            onChange={(e) => setting({ ytExtension: e.target.checked })}
          />
          <span>
            <strong>Extensão do telão nos vídeos do YouTube</strong>
            <span className="muted small">
              {extLine(tv)} Com ela, os vídeos que só tocam no youtube.com abrem numa janela que fecha sozinha no fim da música.
              Desligada, fecha a janela e clica em Terminou no telão.
            </span>
          </span>
        </label>
        <label className="switch">
          <input type="checkbox" checked={settings.tv_add_enabled} onChange={(e) => setting({ tvAddEnabled: e.target.checked })} />
          <span>
            <strong>Adicionar pedido pelo telão</strong>
            <span className="muted small">Mostra um botão “+” discreto no computador, pra quem tá sem celular.</span>
          </span>
        </label>
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

      {withPhoto.length > 0 && (
        <section className="card">
          <h2>
            Fotos no telão <span className="count-pill muted-pill">{withPhoto.length}</span>
          </h2>
          <span className="muted small">Viu foto que não pode? Apaga aqui. A pessoa continua na fila.</span>
          <ul className="rows">
            {withPhoto.map((s) => (
              <li key={s.id}>
                <Avatar src={photoUrl(s, settings)} size={48} />
                <div className="grow">
                  <strong>{s.name}</strong>
                </div>
                <button className="btn danger small" disabled={busy} onClick={() => act('/api/admin/singers', { id: s.id, removePhoto: true })}>
                  Apagar foto
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

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

      <button className="btn ghost small self-start" onClick={logoutAll}>
        Sair de todos os aparelhos
      </button>
    </main>
  );
}

/** "Extensão: ativa / não encontrada / telão desligado", from the projector's last beat. */
function extLine(tv: { tvSeenAt: string | null; extVersion: string | null; extSeenAt: string | null } | null): string {
  if (!tv) return '';
  const fresh = (at: string | null) => !!at && Date.now() - new Date(at).getTime() < 60000;
  if (!fresh(tv.tvSeenAt)) return 'Telão desligado agora.';
  if (tv.extVersion && fresh(tv.extSeenAt)) return `✅ Extensão ativa no telão (v${tv.extVersion}).`;
  return '⚠️ Extensão não encontrada no telão.';
}

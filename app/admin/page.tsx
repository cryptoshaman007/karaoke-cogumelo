'use client';
import { useEffect, useState } from 'react';
import AdminLogin from '../AdminLogin';
import { fmt, post, useLive } from '@/lib/useLive';

export default function AdminPage() {
  const [admin, setAdmin] = useState<boolean | null>(null);
  useEffect(() => {
    fetch('/api/admin/login').then((r) => r.json()).then((d) => setAdmin(!!d.admin)).catch(() => setAdmin(false));
  }, []);
  if (admin === null) return <main className="center">Carregando…</main>;
  if (!admin) return <AdminLogin title="Admin do karaokê" onOk={() => setAdmin(true)} />;
  return <Panel onLogout={() => setAdmin(false)} />;
}

function Panel({ onLogout }: { onLogout: () => void }) {
  const { queue, singers, settings, refresh } = useLive();
  const [err, setErr] = useState('');
  const [minutes, setMinutes] = useState('');

  useEffect(() => {
    if (settings && minutes === '') setMinutes(String(settings.max_duration_sec / 60));
  }, [settings, minutes]);

  async function act(url: string, body: unknown) {
    setErr('');
    try {
      await post(url, body);
      refresh();
    } catch (e) {
      setErr((e as Error).message);
      if ((e as Error).message.includes('login')) onLogout();
    }
  }

  const playing = queue.find((q) => q.status === 'playing');
  const waiting = queue.filter((q) => q.status === 'waiting');
  const all = Object.values(singers);
  const pending = all.filter((s) => s.status === 'pending');
  const blocked = all.filter((s) => s.status === 'blocked');
  const songOf = (singerId: string) => waiting.find((q) => q.singer_id === singerId);

  return (
    <main className="phone admin">
      <header>
        <h1>🍄 Admin</h1>
        <button className="btn small" onClick={async () => (await post('/api/admin/logout', {}), onLogout())}>
          Sair
        </button>
      </header>
      {err && <p className="error">{err}</p>}

      <section className="card">
        <h2>Aguardando aprovação ({pending.length})</h2>
        {pending.length === 0 && <p className="muted">Ninguém esperando.</p>}
        <ul className="rows">
          {pending.map((s) => (
            <li key={s.id}>
              <div>
                <strong>{s.name}</strong>
                <span className="muted small">{songOf(s.id)?.title ?? 'ainda sem música'}</span>
              </div>
              <button className="btn primary" onClick={() => act('/api/admin/singers', { id: s.id, status: 'approved' })}>
                Aprovar
              </button>
              <button className="btn danger" onClick={() => act('/api/admin/singers', { id: s.id, status: 'blocked' })}>
                Recusar
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="card">
        <h2>Tocando agora</h2>
        {playing ? (
          <ul className="rows">
            <li>
              <div>
                <strong>{singers[playing.singer_id]?.name}</strong>
                <span className="muted small">
                  {playing.title} · {fmt(playing.duration_sec)}
                </span>
              </div>
              <button className="btn" onClick={() => act('/api/admin/queue', { action: 'skip', id: playing.id })}>
                ⏭ Pular
              </button>
            </li>
          </ul>
        ) : (
          <p className="muted">Nada tocando.</p>
        )}
      </section>

      <section className="card">
        <h2>Fila ({waiting.length})</h2>
        <ul className="rows">
          {waiting.map((q, i) => {
            const s = singers[q.singer_id];
            return (
              <li key={q.id} className={s?.status !== 'approved' ? 'dim' : ''}>
                <div>
                  <strong>
                    {i + 1}. {s?.name} {s?.status === 'pending' && <em>(aguardando)</em>}
                  </strong>
                  <span className="muted small">
                    {q.title} · {fmt(q.duration_sec)}
                  </span>
                </div>
                <button className="btn small" disabled={i === 0} onClick={() => act('/api/admin/queue', { action: 'up', id: q.id })}>
                  ▲
                </button>
                <button
                  className="btn small"
                  disabled={i === waiting.length - 1}
                  onClick={() => act('/api/admin/queue', { action: 'down', id: q.id })}
                >
                  ▼
                </button>
                <button className="btn small danger" onClick={() => act('/api/admin/queue', { action: 'remove', id: q.id })}>
                  ✕
                </button>
              </li>
            );
          })}
        </ul>
        {waiting.length > 0 && (
          <button
            className="btn danger"
            onClick={() => confirm('Limpar a fila inteira?') && act('/api/admin/queue', { action: 'clear' })}
          >
            Limpar fila
          </button>
        )}
      </section>

      <section className="card">
        <h2>Configurações</h2>
        <label className="field">
          Duração máxima da música (minutos)
          <div className="row">
            <input type="number" min={1} max={30} step={0.5} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
            <button className="btn primary" onClick={() => act('/api/admin/settings', { maxDurationMin: Number(minutes) })}>
              Salvar
            </button>
          </div>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={settings?.require_approval ?? true}
            onChange={(e) => act('/api/admin/settings', { requireApproval: e.target.checked })}
          />
          Pedir aprovação para pessoas novas
        </label>
      </section>

      {blocked.length > 0 && (
        <section className="card">
          <h2>Recusados ({blocked.length})</h2>
          <ul className="rows">
            {blocked.map((s) => (
              <li key={s.id}>
                <strong>{s.name}</strong>
                <button className="btn" onClick={() => act('/api/admin/singers', { id: s.id, status: 'approved' })}>
                  Liberar
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}

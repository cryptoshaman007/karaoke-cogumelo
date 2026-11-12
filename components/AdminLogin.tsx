'use client';
import { useState } from 'react';
import { post } from '@/lib/useLive';

export default function AdminLogin({ title, onOk }: { title: string; onOk: () => void }) {
  const [pw, setPw] = useState('');
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
            await post('/api/admin/login', { password: pw });
            onOk();
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
            <span className="muted small">{title}</span>
          </div>
        </div>
        <input
          type="password"
          placeholder="Senha do admin"
          autoComplete="current-password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          autoFocus
        />
        {err && <p className="error" role="alert">{err}</p>}
        <button className="btn primary block" disabled={busy || !pw}>
          {busy ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </main>
  );
}

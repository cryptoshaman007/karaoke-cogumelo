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
        <h1>🍄 {title}</h1>
        <input type="password" placeholder="Senha do admin" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus />
        {err && <p className="error">{err}</p>}
        <button className="btn primary" disabled={busy || !pw}>
          Entrar
        </button>
      </form>
    </main>
  );
}

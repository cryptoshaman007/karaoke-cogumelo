'use client';
import { useEffect } from 'react';

// Last resort (the whole page failed, including the layout): reload after a moment.
export default function GlobalError({ error }: { error: Error }) {
  useEffect(() => {
    console.error('page crashed', error);
    const t = setTimeout(() => window.location.reload(), 10000);
    return () => clearTimeout(t);
  }, [error]);
  return (
    <html lang="pt-BR">
      <body style={{ background: '#0b0b0f', color: '#f4f4f7', fontFamily: 'system-ui, sans-serif', display: 'grid', placeItems: 'center', minHeight: '100vh', margin: 0 }}>
        <p>Só um instante, voltando…</p>
      </body>
    </html>
  );
}

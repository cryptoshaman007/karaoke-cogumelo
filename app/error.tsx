'use client';
import { useEffect } from 'react';

// If a screen breaks, it puts itself back together instead of leaving the projector on an error page.
const KEY = 'karaoke_crashes';

export default function ErrorScreen({ error, reset }: { error: Error; reset: () => void }) {
  useEffect(() => {
    console.error('screen crashed', error);
    let recent: number[] = [];
    try {
      recent = (JSON.parse(sessionStorage.getItem(KEY) ?? '[]') as number[]).filter((t) => Date.now() - t < 60000);
      recent.push(Date.now());
      sessionStorage.setItem(KEY, JSON.stringify(recent));
    } catch {}
    // first tries: rebuild the screen in place (keeps the sound allowed). Keeps failing: full reload,
    // spaced out so a broken page never reloads in a tight loop.
    const t = setTimeout(() => (recent.length <= 3 ? reset() : window.location.reload()), recent.length <= 3 ? 1500 : 10000);
    return () => clearTimeout(t);
  }, [error, reset]);

  return (
    <main className="center">
      <div className="card narrow" style={{ textAlign: 'center' }}>
        <span className="spinner big" aria-hidden="true" />
        <p>Só um instante, já voltamos…</p>
        <button className="btn" onClick={() => window.location.reload()}>
          Recarregar agora
        </button>
      </div>
    </main>
  );
}

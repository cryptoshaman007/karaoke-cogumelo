// Talks with the "Karaokê Cogumelo – Telão" Chrome extension (folder extensao-chrome/), when it is
// installed on the projector PC. The extension opens the YouTube window for videos that only play
// on youtube.com, follows the video there and says when it ended, so the queue moves by itself.
// Without it (or if it stops answering) the projector falls back to the manual way: close the
// YouTube window and press "Terminou".

export type ExtMessage =
  | { type: 'ready'; version: string }
  | { type: 'gone' }
  | { type: 'opened'; queueId: number }
  | { type: 'status'; queueId: number; time: number; duration: number; paused: boolean; ad: boolean }
  | { type: 'ended'; queueId: number }
  | { type: 'closed'; queueId: number }
  | { type: 'error'; queueId?: number; reason?: string };

function send(msg: Record<string, unknown>) {
  try {
    window.postMessage({ source: 'karaoke-page', ...msg }, window.location.origin);
  } catch {}
}

/** Listens to the extension. Returns the function that stops listening. */
export function listenExtension(onMessage: (m: ExtMessage) => void): () => void {
  const handler = (e: MessageEvent) => {
    if (e.source !== window || e.origin !== window.location.origin) return;
    const d = e.data as { source?: string; version?: string } & Record<string, unknown>;
    if (!d || d.source !== 'karaoke-ext' || typeof d.type !== 'string') return;
    onMessage({ ...(d as object), version: String(d.version ?? '') } as ExtMessage);
  };
  window.addEventListener('message', handler);
  send({ type: 'hello' });
  return () => window.removeEventListener('message', handler);
}

export function extOpen(opts: { queueId: number; videoId: string; start: number; mode: 'page' | 'video'; rect: { x: number; y: number; w: number; h: number } }) {
  send({ type: 'open', ...opts });
}

export function extClose(queueId?: number) {
  send({ type: 'close', queueId });
}

export function extCommand(queueId: number, cmd: 'pause' | 'play' | 'restart' | 'volume', value?: number) {
  send({ type: 'cmd', queueId, cmd, value });
}

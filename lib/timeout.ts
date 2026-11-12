/** An AbortSignal that fires after `ms`. (Plain timer: also works on older phones.) */
export function timeoutSignal(ms: number): AbortSignal {
  const c = new AbortController();
  setTimeout(() => c.abort(new DOMException('timeout', 'TimeoutError')), ms);
  return c.signal;
}

/**
 * fetch that gives up after `ms` instead of hanging forever. A request stuck on a bad Wi-Fi
 * connection must never keep the queue (or a button) locked.
 */
export function fetchWithTimeout(ms: number): typeof fetch {
  return (input, init) => fetch(input, { ...init, signal: init?.signal ?? timeoutSignal(ms) });
}

/** Rejects with Error('timeout') if the promise takes longer than `ms`. */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

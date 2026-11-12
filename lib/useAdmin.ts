'use client';
import { useEffect, useState } from 'react';
import { timeoutSignal } from './timeout';

/**
 * Asks the server if this browser is logged in as admin. null = still checking.
 * A network hiccup keeps retrying instead of dropping to the password screen: the projector PC
 * may open the page before the internet is back.
 */
export function useAdmin(): [boolean | null, (v: boolean) => void] {
  const [admin, setAdmin] = useState<boolean | null>(null);
  useEffect(() => {
    if (admin !== null) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      try {
        const res = await fetch('/api/admin/login', { cache: 'no-store', signal: timeoutSignal(8000) });
        if (stop) return;
        if (res.ok) return setAdmin(!!(await res.json()).admin);
      } catch {}
      if (!stop) timer = setTimeout(check, 3000);
    };
    check();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [admin]);
  return [admin, setAdmin];
}

'use client';

import { Analytics, type BeforeSendEvent } from '@vercel/analytics/next';

/** Vercel Web Analytics sem levar o código de emergência (?c=) pro painel. */
function stripSecrets(event: BeforeSendEvent): BeforeSendEvent {
  try {
    const url = new URL(event.url);
    if (url.searchParams.has('c')) {
      url.searchParams.delete('c');
      return { ...event, url: url.toString() };
    }
  } catch {}
  return event;
}

export default function SiteAnalytics() {
  return <Analytics beforeSend={stripSecrets} />;
}

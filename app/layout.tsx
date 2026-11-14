import type { Metadata, Viewport } from 'next';
import SiteAnalytics from '@/components/SiteAnalytics';
import './globals.css';

export const metadata: Metadata = {
  title: 'Karaokê Cogumelo',
  description: 'Escaneia, escolhe a música e solta a voz!',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  themeColor: '#0b0b0f',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>
        {children}
        <SiteAnalytics />
      </body>
    </html>
  );
}

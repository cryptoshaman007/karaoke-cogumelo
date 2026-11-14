import { NextResponse, type NextRequest } from 'next/server';
import { SING_HOST } from './lib/siteUrls';

/** cantar.cogumelobar.com abre direto a tela do cantor (o endereço continua curto). */
export function middleware(req: NextRequest) {
  const host = (req.headers.get('host') ?? '').split(':')[0].toLowerCase();
  if (host === SING_HOST && req.nextUrl.pathname === '/') {
    const url = req.nextUrl.clone();
    url.pathname = '/cantar';
    return NextResponse.rewrite(url);
  }
  return NextResponse.next();
}

export const config = { matcher: '/' };

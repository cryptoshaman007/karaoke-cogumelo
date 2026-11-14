/** Endereço próprio da tela do cantor (o que vai no QR do telão). */
export const SING_HOST = 'cantar.cogumelobar.com';

/** Hosts "de verdade" do bar: neles o QR manda pro endereço curto do cantor. */
const PROD_HOSTS = ['karaoke-cogumelo.vercel.app'];

/**
 * Link do QR "escaneia e vem cantar". No bar (cogumelobar.com ou o vercel.app de produção)
 * é sempre https://cantar.cogumelobar.com. Em localhost e nas prévias da Vercel continua
 * apontando pro próprio site, pra dar pra testar sem mexer na produção.
 */
export function singUrlFor(origin: string): string {
  if (!origin) return '';
  let host = '';
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return `${origin}/cantar`;
  }
  if (host === 'cogumelobar.com' || host.endsWith('.cogumelobar.com') || PROD_HOSTS.includes(host)) {
    return `https://${SING_HOST}`;
  }
  return `${origin}/cantar`;
}

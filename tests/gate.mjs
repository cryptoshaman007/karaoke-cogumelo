// Testes do "Só Brasil" e do código da noite, contra o servidor de verdade e um banco falso.
//
// Como rodar:
//   1. crie .env.local com NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 (e as outras três
//      variáveis com qualquer valor), rode `npm run build` e `npx next start -p 3112`
//   2. `node tests/gate.mjs` (leva uns 40 s: espera o cache de 10 s do servidor algumas vezes)

import http from 'http';
const DB = { only_brazil: false, night_code_at: null, code: null, adminHash: null, rate: 0 };
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    const send = (o, s = 200) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (p === '/rest/v1/settings' && req.method === 'GET') return send({ id: 1, only_brazil: DB.only_brazil, night_code_at: DB.night_code_at, require_approval: false, max_duration_sec: 360 });
    if (p === '/rest/v1/settings' && req.method === 'PATCH') { Object.assign(DB, JSON.parse(body)); return send([], 200); }
    if (p === '/rest/v1/night_code' && req.method === 'GET') return send(DB.code ? { code: DB.code } : null);
    if (p === '/rest/v1/night_code' && req.method === 'POST') { DB.code = JSON.parse(body).code ?? JSON.parse(body)[0]?.code; return send([], 201); }
    if (p === '/rest/v1/rpc/rate_hit') { DB.rate++; return send(DB.rate <= 1000); }
    if (p === '/rest/v1/admin_sessions') {
      const h = u.searchParams.get('token_hash');
      if (h && h === 'eq.' + DB.adminHash) return send({ last_seen_at: new Date().toISOString(), expires_at: new Date(Date.now() + 1e9).toISOString() });
      return send(null);
    }
    if (p === '/rest/v1/singers' && req.method === 'GET') return send({ id: 's1', name: 'Ana', status: 'approved', created_at: new Date().toISOString() });
    if (p === '/rest/v1/singers' && req.method === 'POST') return send({ id: 's2', name: 'Novo', status: 'approved', created_at: new Date().toISOString() });
    send({ message: 'not faked ' + req.method + ' ' + p }, 404);
  });
});
await new Promise((r) => fake.listen(54321, r));
const BASE = 'http://localhost:3112';
let fails = 0;
const ok = (c, m) => { console.log((c ? 'ok   ' : 'FAIL ') + m); if (!c) fails++; };
const call = (path, { method = 'GET', body, country, cookie, token } = {}) =>
  fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(country ? { 'x-vercel-ip-country': country } : {}), ...(cookie ? { cookie } : {}), ...(token ? { 'x-singer-token': token } : {}) }, body: body && JSON.stringify(body) });
const wait = () => new Promise((r) => setTimeout(r, 10500)); // server cache

let r = await call('/api/me', { token: 't', country: 'US' });
ok(r.status === 200, 'all off: US phone passes');
DB.only_brazil = true; await wait();
r = await call('/api/me', { token: 't', country: 'US' });
let d = await r.json();
ok(r.status === 403 && d.gate === 'geo', 'só Brasil: US blocked on /api/me ' + r.status);
r = await call('/api/join', { method: 'POST', body: { name: 'Bot' }, country: 'DE' });
ok(r.status === 403, 'só Brasil: DE blocked on join');
r = await call('/api/me', { token: 't', country: 'BR' });
ok(r.status === 200, 'só Brasil: BR passes');
r = await call('/api/me', { token: 't' });
ok(r.status === 200, 'só Brasil: no country header passes');
d = await (await call('/api/gate', { country: 'US' })).json();
ok(d.gate === 'geo', 'gate GET says geo for US');
// admin abroad
const { createHash } = await import('crypto');
const adminTok = 's1.abc';
DB.adminHash = createHash('sha256').update(adminTok).digest('hex');
r = await call('/api/me', { token: 't', country: 'US', cookie: 'karaoke_admin=' + adminTok });
ok(r.status === 200, 'admin cookie abroad passes');
d = await (await call('/api/gate', { country: 'US', cookie: 'karaoke_admin=' + adminTok })).json();
ok(d.ok === true, 'gate GET ok for admin abroad');
DB.only_brazil = false;
// night code
r = await call('/api/admin/guard', { method: 'POST', body: { action: 'new' } });
ok(r.status === 401, 'guard new needs admin');
r = await call('/api/admin/guard', { method: 'POST', body: { action: 'new' }, cookie: 'karaoke_admin=' + adminTok });
d = await r.json();
ok(r.status === 200 && /^[A-Z0-9]{5}$/.test(d.code), 'admin creates code ' + d.code);
const code = d.code;
ok(DB.night_code_at && DB.code === code, 'db has code and night_code_at');
d = await (await call('/api/admin/guard', { cookie: 'karaoke_admin=' + adminTok })).json();
ok(d.code === code, 'admin reads code');
await wait();
r = await call('/api/me', { token: 't', country: 'BR' });
d = await r.json();
ok(r.status === 403 && d.gate === 'code', 'code on: phone without cookie blocked');
r = await call('/api/gate', { method: 'POST', body: { code: 'WRONG' }, country: 'BR' });
ok(r.status === 400, 'wrong code refused');
r = await call('/api/gate', { method: 'POST', body: { code: code.toLowerCase() }, country: 'BR' });
const setCookie = r.headers.get('set-cookie') ?? '';
ok(r.status === 200 && setCookie.includes('karaoke_noite=' + code), 'right code (lowercase) sets cookie');
r = await call('/api/me', { token: 't', country: 'BR', cookie: 'karaoke_noite=' + code });
ok(r.status === 200, 'with cookie passes');
r = await call('/api/me', { token: 't', country: 'BR', cookie: 'karaoke_noite=OLD12' });
ok(r.status === 403, 'old code cookie blocked');
r = await call('/api/search?q=ab', { token: 't', country: 'BR' });
ok(r.status === 403, 'search blocked without code');
r = await call('/api/popular');
ok(r.status === 200, 'popular still open');
r = await call('/api/admin/guard', { method: 'POST', body: { action: 'off' }, cookie: 'karaoke_admin=' + adminTok });
ok(r.status === 200 && DB.night_code_at === null, 'admin turns code off');
await wait();
r = await call('/api/me', { token: 't', country: 'BR' });
ok(r.status === 200, 'code off: printed QR works again');
fake.close();
console.log(fails ? `${fails} FAILED` : 'ALL OK');
process.exit(fails ? 1 : 0);

// Testes de estabilidade do telão e do celular, com banco, servidor e YouTube simulados.
//
// Como rodar:
//   1. crie .env.local com NEXT_PUBLIC_SUPABASE_URL=https://fake.supabase.co (e as outras três
//      variáveis com qualquer valor) e rode `npm run build`
//   2. `npx next start -p 3111` em um terminal
//   3. `node tests/stability.mjs` em outro (precisa do pacote `playwright` instalado)
//
// Nada aqui toca no banco de verdade: o navegador de teste intercepta todas as chamadas.
// O relógio do navegador é controlado pelo teste, então horas de karaokê passam em segundos.

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BASE = process.env.BASE_URL ?? 'http://localhost:3111';
const SELFIE = (await import('fs')).readFileSync(new URL('./fixtures-selfie.jpg', import.meta.url));
const ONLY = process.argv[2] ?? '';

// ---------------------------------------------------------------- fake YouTube player (in the page)
const FAKE_YT = `
(() => {
  const S = { ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5, UNSTARTED: -1 };
  const yt = (window.__yt = window.__yt || { players: [], loads: [], behavior: {}, dur: {}, noReady: 0 });
  function Player(el, opts) {
    if (typeof el === 'string') el = document.getElementById(el);
    const iframe = document.createElement('iframe');
    el.replaceWith(iframe);
    const p = this;
    Object.assign(p, { state: -1, time: 0, videoId: null, volume: 100, destroyed: false, mode: 'ok', stallAt: null });
    yt.players.push(p);
    const fire = (name, data) => setTimeout(() => !p.destroyed && opts.events[name] && opts.events[name]({ data }), 0);
    const set = (s) => { if (p.state !== s) { p.state = s; fire('onStateChange', s); } };
    p._set = set;
    p._fire = fire;
    p.tick = setInterval(() => {
      if (p.destroyed || p.state !== S.PLAYING) return;
      const dur = yt.dur[p.videoId] ?? 20;
      p.time += 0.25;
      if (p.stallAt != null && p.time >= p.stallAt) { p.stallAt = null; return set(S.BUFFERING); }
      if (p.time >= dur) {
        p.time = dur;
        if (p.mode === 'noend') p.state = S.ENDED; // finished, but the event is "lost"
        else {
          set(S.ENDED);
          if (p.mode === 'doubleend') fire('onStateChange', S.ENDED);
        }
      }
    }, 250);
    const start = (videoId, startSeconds, cue) => {
      p.videoId = videoId;
      p.time = startSeconds || 0;
      let mode = yt.behavior[videoId] ?? 'ok';
      if (Array.isArray(mode)) mode = mode.length > 1 ? mode.shift() : mode[0]; // one behaviour per load
      p.mode = mode;
      yt.loads.push({ videoId, startSeconds: p.time, cue: !!cue, mode });
      p.stallAt = null;
      if (cue) return set(S.CUED);
      if (mode === 'dead') return set(S.UNSTARTED);
      // slow start (bad internet or an ad): nothing for 15 s, then it plays
      if (mode === 'late') {
        set(S.UNSTARTED);
        return void setTimeout(() => {
          if (p.destroyed || p.videoId !== videoId) return;
          set(S.BUFFERING);
          setTimeout(() => !p.destroyed && p.videoId === videoId && set(S.PLAYING), 300);
        }, 15000);
      }
      // the player still says "ended" (the previous video) for a moment after loading
      if (mode === 'staleend') {
        p.state = S.ENDED;
        fire('onStateChange', S.ENDED);
        return setTimeout(() => {
          if (p.destroyed || p.videoId !== videoId) return;
          set(S.BUFFERING);
          setTimeout(() => !p.destroyed && p.videoId === videoId && set(S.PLAYING), 300);
        }, 3500);
      }
      if (mode === 'soundblocked' && !p.muted) return set(S.UNSTARTED); // Chrome holding the sound until a click
      if (typeof mode === 'string' && mode.startsWith('error')) { set(S.UNSTARTED); return fire('onError', Number(mode.slice(5))); }
      if (typeof mode === 'string' && mode.startsWith('stall')) p.stallAt = Number(mode.slice(5));
      set(S.BUFFERING);
      setTimeout(() => !p.destroyed && p.videoId === videoId && p.state === S.BUFFERING && p.stallAt !== -1 && set(S.PLAYING), 300);
    };
    p.loadVideoById = (o) => start(o.videoId, o.startSeconds, false);
    p.cueVideoById = (o) => start(o.videoId, o.startSeconds, true);
    p.playVideo = () => {
      if ([S.PAUSED, S.CUED].includes(p.state)) set(S.PLAYING);
      else if (p.state === S.UNSTARTED && p.mode === 'soundblocked' && p.muted) set(S.PLAYING);
    };
    p.mute = () => { p.muted = true; };
    // Chrome pauses a video that tries to get its sound back without a click
    p.unMute = () => {
      p.muted = false;
      if (p.mode === 'soundblocked' && !navigator.userActivation?.hasBeenActive && p.state === S.PLAYING) set(S.PAUSED);
    };
    p.pauseVideo = () => { if (p.state === S.PLAYING || p.state === S.BUFFERING) set(S.PAUSED); };
    p.stopVideo = () => { p.state = S.UNSTARTED; };
    p.seekTo = (t) => { p.time = t; };
    p.setVolume = (v) => { p.volume = v; };
    p.getCurrentTime = () => p.time;
    p.getPlayerState = () => p.state;
    p.destroy = () => { p.destroyed = true; clearInterval(p.tick); iframe.remove(); };
    if (yt.noReady > 0) yt.noReady--;
    else setTimeout(() => !p.destroyed && opts.events.onReady && opts.events.onReady({}), 100);
  }
  window.YT = { Player, PlayerState: S };
  window.onYouTubeIframeAPIReady && window.onYouTubeIframeAPIReady();
})();
`;

// ---------------------------------------------------------------- fake backend (in this process)
function makeBackend() {
  const b = {
    queue: [],
    singers: {},
    settings: {
      id: 1, max_duration_sec: 360, require_approval: true, queue_open: true, intermission_sec: 2, tv_message: '',
      paused: false, volume: 100, restart_at: null, contest_id: null, results_contest_id: null, reactions_enabled: true,
      tv_add_enabled: true, songs_per_person: 1,
    },
    nextId: 1,
    playerCalls: [],
    apiCalls: [],
    // failure switches
    restDown: false, // Supabase REST unreachable
    playerMode: 'ok', // 'ok' | 'fail' | 'hang' | '401'
    ytScriptFailures: 0,
    sockets: new Set(),
    wsMode: 'ok', // 'ok' | 'refuse'
    restDelay: 0, // ms each Supabase answer takes
    searchMode: 'ok', // 'ok' | 'hang'
    queuePosts: 0,
    reserves: [],
    // same rule as the promote_reserves SQL function
    promote() {
      for (const sid of [...new Set(b.reserves.map((r) => r.singer_id))]) {
        if (b.queue.some((q) => q.singer_id === sid && ['waiting', 'playing'].includes(q.status))) continue;
        const r = b.reserves.find((x) => x.singer_id === sid);
        b.reserves.splice(b.reserves.indexOf(r), 1);
        b.queue.push({ ...r, id: b.nextId++, status: 'waiting', position: b.nextId, started_at: null });
      }
    },
    add(name, videoId, { status = 'approved', duration = 20 } = {}) {
      const sid = `00000000-0000-4000-8000-${String(b.nextId).padStart(12, '0')}`;
      b.singers[sid] = { id: sid, name, status, created_at: new Date().toISOString() };
      const row = {
        id: b.nextId++, singer_id: sid, video_id: videoId, title: `${videoId} (karaoke)`, thumbnail: null,
        duration_sec: duration, status: 'waiting', position: b.nextId, created_at: new Date().toISOString(), started_at: null,
      };
      b.queue.push(row);
      b.notify('queue');
      return row;
    },
    playing: () => b.queue.find((q) => q.status === 'playing') ?? null,
    // same rules as the advance_queue SQL function
    advance(current, endStatus) {
      const playing = b.playing();
      if (playing && (current == null || playing.id !== current)) return playing.id;
      if (playing) playing.status = endStatus;
      const next = b.queue
        .filter((q) => q.status === 'waiting' && b.singers[q.singer_id]?.status === 'approved')
        .sort((x, y) => x.position - y.position || x.id - y.id)[0];
      if (next) {
        next.status = 'playing';
        next.started_at = new Date().toISOString();
      }
      b.settings.paused = false;
      b.promote();
      b.notify('queue');
      return next?.id ?? null;
    },
    notify(table) {
      for (const s of b.sockets) s.push(table);
    },
    insert(table, record) {
      for (const s of b.sockets) s.push(table, 'INSERT', record);
    },
    tvOwner: null,
    tvSeen: 0,
    claimTv(id, force) {
      const now = Date.now();
      if (force || !b.tvOwner || b.tvOwner === id || now - b.tvSeen > 30000) {
        b.tvOwner = id;
        b.tvSeen = now;
        return true;
      }
      return false;
    },
    nightMode: 'fresh', // 'fresh' | 'reset' | 'hang'
    nightCalls: 0,
    dropSockets() {
      for (const s of [...b.sockets]) s.close();
    },
  };
  return b;
}

async function wire(page, b, { admin = true } = {}) {
  await page.route('https://www.youtube.com/iframe_api', (route) => {
    if (b.ytScriptFailures > 0) {
      b.ytScriptFailures--;
      return route.abort('internetdisconnected');
    }
    return route.fulfill({ contentType: 'text/javascript', body: FAKE_YT });
  });
  await page.route(/i\.ytimg\.com/, (route) => route.fulfill({ status: 204, body: '' }));

  await page.route(/fake\.supabase\.co\/rest\/v1\//, (route) => {
    if (b.restDown) return route.abort('internetdisconnected');
    const url = new URL(route.request().url());
    const table = url.pathname.split('/').pop();
    const single = (route.request().headers()['accept'] ?? '').includes('vnd.pgrst.object');
    let body;
    if (table === 'queue' && url.searchParams.get('id')?.startsWith('eq.')) {
      // one row by id (the projector asking for the grade of the song that just ended)
      const row = b.queue.find((q) => `eq.${q.id}` === url.searchParams.get('id')) ?? null;
      body = single ? row : row ? [row] : [];
    } else if (table === 'queue' && url.searchParams.get('score')) {
      // night ranking: graded songs, best first
      body = b.queue.filter((q) => q.score != null).sort((x, y) => y.score - x.score);
    } else if (table === 'queue') {
      body = b.queue.filter((q) => ['waiting', 'playing'].includes(q.status)).sort((x, y) => x.position - y.position || x.id - y.id);
    } else if (table === 'settings') body = single ? b.settings : [b.settings];
    else if (table === 'singers' && b.noPhotoColumn && (url.searchParams.get('select') ?? '').includes('photo_at')) {
      // database without update 006
      return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: '42703', message: 'column singers.photo_at does not exist' }) });
    } else if (table === 'singers') {
      const idf = url.searchParams.get('id');
      const st = url.searchParams.get('status');
      if (idf) {
        const ids = idf.replace(/^in\.\(|\)$/g, '').split(',').map((s) => s.replace(/"/g, ''));
        body = ids.map((i) => b.singers[i]).filter(Boolean);
      } else body = Object.values(b.singers).filter((s) => !st || `eq.${s.status}` === st);
    } else body = single ? null : [];
    const answer = () => route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) }).catch(() => {});
    return b.restDelay ? void setTimeout(answer, b.restDelay) : answer();
  });

  await page.route(/\/api\//, async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const body = req.postDataJSON?.() ?? {};
    b.apiCalls.push({ path, method: req.method(), body });
    const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (path === '/api/admin/login') return json({ admin });
    if (path === '/api/tv') {
      b.tvCalls = (b.tvCalls ?? []).concat({ ...body });
      // a mirror (passive) never takes over by itself: it only renews a lock it already holds
      if (body.passive === true && !body.force) return json({ owner: b.tvOwner === body.id ? b.claimTv(body.id, false) : false });
      return json({ owner: b.claimTv(body.id, body.force === true) });
    }
    if (path === '/api/admin/singers' && req.method() === 'GET') return json({ singers: b.oldBlocked ?? [] });
    if (path === '/api/player') {
      b.playerCalls.push({ ...body, mode: b.playerMode });
      if (body.tv && !b.claimTv(body.tv, false)) return json({ error: 'Outro telão tá no comando.', notOwner: true }, 409);
      if (b.playerMode === 'fail') return route.abort('internetdisconnected');
      if (b.playerMode === 'hang') return; // never answers
      if (b.playerMode === '401') return json({ error: 'Faça login no admin' }, 401);
      return json({ playing: b.advance(body.current ?? null, body.endStatus === 'skipped' ? 'skipped' : 'done') });
    }
    if (path === '/api/night') {
      b.nightCalls++;
      if (b.nightMode === 'hang') return; // never answers
      if (b.nightMode === 'reset') {
        for (const q of b.queue) if (['waiting', 'playing'].includes(q.status)) q.status = 'skipped';
        b.nightMode = 'fresh';
        b.notify('queue');
        return json({ ok: true, result: 'reset' });
      }
      return json({ ok: true, result: 'fresh' });
    }
    if (path === '/api/admin/settings') {
      if (body.rankingOnTv != null) b.settings.ranking_on_tv = !!body.rankingOnTv;
      if (body.paused != null) b.settings.paused = !!body.paused;
      if (body.restart) Object.assign(b.settings, { restart_at: new Date().toISOString(), paused: false });
      b.notify('settings');
      return json({ ok: true });
    }
    if (path === '/api/popular') return json({ songs: [] });
    if (path === '/api/gif') return json(req.method() === 'GET' ? { search: false, results: [] } : { ok: true });
    if (path === '/api/join') {
      const sid = `00000000-0000-4000-9000-${String(b.nextId++).padStart(12, '0')}`;
      b.singers[sid] = { id: sid, name: body.name, status: 'approved', created_at: new Date().toISOString() };
      b.me = b.singers[sid];
      return json({ token: 'tok', singer: b.me });
    }
    if (path === '/api/me') return json({ singer: b.me });
    if (path === '/api/vote') {
      const cur = b.playing();
      if (req.method() === 'POST') {
        b.votes = (b.votes ?? []).concat({ queueId: cur?.id ?? null, score: body.score });
        return json({ ok: true, queueId: cur?.id ?? null, score: body.score });
      }
      return json({ queueId: cur?.id ?? null, score: null });
    }
    if (path.startsWith('/api/photo/')) {
      b.photoLoads = (b.photoLoads ?? 0) + 1;
      return route.fulfill({ contentType: 'image/jpeg', body: SELFIE });
    }
    if (path === '/api/photo') {
      if (req.method() === 'POST') {
        b.photoPosts = (b.photoPosts ?? []).concat(String(body.jpeg ?? ''));
        b.singers[b.me.id].photo_at = new Date().toISOString();
      } else delete b.singers[b.me.id].photo_at;
      b.notify('singers');
      return json({ ok: true });
    }
    if (path === '/api/search') {
      if (b.searchMode === 'hang') return;
      const q = new URL(req.url()).searchParams.get('q') ?? '';
      if (/youtu/.test(q)) {
        return json({ results: [{ videoId: 'linkAAAAAA1', title: 'Evidências - Chitãozinho e Xororó (clipe oficial)', thumbnail: '', durationSec: 240, channel: 'Canal' }], fromLink: true, karaoke: false });
      }
      return json({ results: [{ videoId: 'pickAAAAAA1', title: 'Evidências (karaoke)', thumbnail: '', durationSec: 200, channel: 'Canal' }] });
    }
    if (path === '/api/queue' && req.method() === 'GET') {
      return json({ reserves: b.reserves.filter((r) => r.singer_id === b.me.id) });
    }
    if (path === '/api/queue' && req.method() === 'DELETE') {
      const rid = new URL(req.url()).searchParams.get('reserve');
      if (rid) b.reserves = b.reserves.filter((r) => String(r.id) !== rid);
      return json({ ok: true });
    }
    if (path === '/api/queue' && req.method() === 'PUT') {
      const mine = b.queue.find((q) => q.singer_id === b.me.id && q.status === 'waiting');
      if (!mine) return json({ error: 'Sua música já começou ou saiu da fila.' }, 409);
      Object.assign(mine, { video_id: body.videoId, title: body.title, duration_sec: body.durationSec });
      b.swaps = (b.swaps ?? 0) + 1;
      b.notify('queue');
      return json({ ok: true });
    }
    if (path === '/api/contest' || path === '/api/admin/contest') {
      if (body.action === 'hide') b.settings.results_contest_id = null;
      b.notify('settings');
      return json({ ok: true });
    }
    if (path === '/api/queue' && req.method() === 'POST') {
      b.queuePosts++;
      await new Promise((r) => setTimeout(r, 300));
      const row = {
        id: b.nextId++, singer_id: b.me.id, video_id: body.videoId, title: body.title, thumbnail: null, duration_sec: body.durationSec,
        created_at: new Date().toISOString(),
      };
      if (b.queue.some((q) => q.singer_id === b.me.id && ['waiting', 'playing'].includes(q.status))) {
        const mine = b.reserves.filter((r) => r.singer_id === b.me.id).length;
        if (1 + mine >= b.settings.songs_per_person) return json({ error: 'Você já tem uma música na fila. Espere ela tocar!' }, 409);
        b.reserves.push(row);
        return json({ ok: true, where: 'reserve' });
      }
      b.queue.push({ ...row, status: 'waiting', position: b.nextId, started_at: null });
      b.notify('queue');
      return json({ ok: true, where: 'queue' });
    }
    if (path === '/api/admin/queue' && body.action === 'add') {
      if (body.from === 'tv' && !b.settings.tv_add_enabled) return json({ error: 'Adicionar pelo telão está desligado.' }, 403);
      b.add(body.name, body.song.videoId, { duration: body.song.durationSec });
      return json({ ok: true });
    }
    return json({ error: 'not mocked' }, 404);
  });

  // Supabase Realtime (Phoenix protocol, vsn 2.0.0: [join_ref, ref, topic, event, payload])
  await page.routeWebSocket(/fake\.supabase\.co\/realtime/, (ws) => {
    if (b.wsMode === 'refuse') return ws.close();
    const topics = new Map();
    const sock = {
      push(table, type = 'UPDATE', record = {}) {
        for (const [topic, binds] of topics) {
          const ids = binds.filter((x) => x.table === table).map((x) => x.id);
          if (!ids.length) continue;
          const data = { type, schema: 'public', table, commit_timestamp: new Date().toISOString(), columns: [], record, old_record: {}, errors: null };
          try {
            ws.send(JSON.stringify([null, null, topic, 'postgres_changes', { ids, data }]));
          } catch {}
        }
      },
      close() {
        b.sockets.delete(sock);
        try {
          ws.close();
        } catch {}
      },
    };
    b.sockets.add(sock);
    ws.onClose(() => b.sockets.delete(sock));
    ws.onMessage((raw) => {
      let m;
      try {
        m = JSON.parse(raw);
      } catch {
        return;
      }
      const [joinRef, ref, topic, event, payload] = m;
      const reply = (response) => ws.send(JSON.stringify([joinRef, ref, topic, 'phx_reply', { status: 'ok', response }]));
      if (event === 'phx_join') {
        const binds = (payload?.config?.postgres_changes ?? []).map((f, i) => ({ ...f, id: i + 1 }));
        topics.set(topic, binds);
        return reply({ postgres_changes: binds });
      }
      if (event === 'phx_leave') topics.delete(topic);
      return reply({});
    });
  });
}

// ---------------------------------------------------------------- helpers
const results = [];
let browser;

async function openTv(b, { click = true, admin = true } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.clock.install();
  await wire(page, b, { admin });
  await page.goto(BASE + '/');
  if (click && admin) {
    await run(page, 500);
    await page.locator('.start-overlay').click();
    await run(page, 1000);
  }
  return { page, ctx, errors };
}

/** Lets `ms` of browser time pass, in small steps so network mocks get to answer in between. */
async function run(page, ms, step = 250) {
  for (let t = 0; t < ms; t += step) {
    await page.clock.runFor(Math.min(step, ms - t));
    await new Promise((r) => setTimeout(r, 4));
  }
}
/** Runs the clock until `fn` (evaluated here) is true. Returns the browser time spent, or -1. */
async function until(page, fn, maxMs, step = 250) {
  for (let t = 0; t <= maxMs; t += step) {
    if (await fn()) return t;
    await run(page, step, step);
  }
  return -1;
}
const yt = (page) => page.evaluate(() => {
  const y = window.__yt;
  const p = y?.players.filter((x) => !x.destroyed).pop();
  return { loads: y?.loads ?? [], players: y?.players.length ?? 0, state: p?.state, time: p?.time, videoId: p?.videoId };
});
const statuses = (b) => b.queue.map((q) => `${q.video_id}:${q.status}`).join(' ');

/** With SHOTS=<folder> the new screens are photographed along the way (to check the look). */
async function shot(page, name) {
  if (!process.env.SHOTS) return;
  await new Promise((r) => setTimeout(r, 700)); // real time, so CSS animations finish
  await page.screenshot({ path: `${process.env.SHOTS}/${name}.png` });
}

/** Real time (not browser time): the fake server's own delays run on the real clock. */
const settle = (ms = 800) => new Promise((r) => setTimeout(r, ms));

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function test(name, fn) {
  if (ONLY && !name.toLowerCase().includes(ONLY.toLowerCase())) return;
  const t0 = Date.now();
  try {
    const note = await fn();
    results.push({ name, ok: true, note });
    console.log(`  PASS  ${name}${note ? `  (${note})` : ''}  [${Date.now() - t0} ms]`);
  } catch (e) {
    results.push({ name, ok: false, note: e.message });
    console.log(`  FAIL  ${name}\n        ${e.message}`);
  }
}

// ---------------------------------------------------------------- scenarios
browser = await chromium.launch();

await test('fila normal: três músicas tocam em ordem e o telão volta para a tela de espera', async () => {
  const b = makeBackend();
  b.add('Ana', 'vidAAAAAAA1');
  b.add('Bia', 'vidBBBBBBB2');
  b.add('Caio', 'vidCCCCCCC3');
  const { page, ctx, errors } = await openTv(b);
  const t = await until(page, async () => b.queue.every((q) => q.status === 'done'), 120000);
  expect(t >= 0, `fila não terminou: ${statuses(b)}`);
  const y = await yt(page);
  expect(y.loads.map((l) => l.videoId).join() === 'vidAAAAAAA1,vidBBBBBBB2,vidCCCCCCC3', `ordem errada: ${JSON.stringify(y.loads)}`);
  await run(page, 1000);
  expect(await page.locator('.idle').isVisible(), 'tela de espera não voltou');
  expect(errors.length === 0, errors.join('; '));
  await ctx.close();
  return `${Math.round(t / 1000)} s de karaokê`;
});

await test('vídeo bloqueado para embed: abre no youtube.com, espera o "Terminou" e só então segue', async () => {
  const b = makeBackend();
  b.add('Ana', 'blockedAAA1');
  b.add('Bia', 'vidBBBBBBB2');
  const { page, ctx } = await openTv(b);
  // the real youtube.com cuts the link to the window (COOP): the projector then reads win.closed = true
  await ctx.route(/https:\/\/www\.youtube\.com\/watch/, (route) =>
    route.fulfill({ contentType: 'text/html', headers: { 'cross-origin-opener-policy': 'same-origin-allow-popups' }, body: '<p>YT</p>' }),
  );
  const popups = [];
  ctx.on('page', (p) => popups.push(p));
  await page.evaluate(() => (window.__yt.behavior.blockedAAA1 = 'error150'));
  const t = await until(page, async () => popups.some((p) => p.url().includes('blockedAAA1')), 30000);
  expect(t >= 0, 'não abriu a janela do YouTube');
  await run(page, 60000);
  expect(b.queue[0].status === 'playing' && b.queue[1].status === 'waiting', `a fila andou sozinha: ${statuses(b)}`);
  expect(popups.length === 1, `abriu ${popups.length} janelas do YouTube`);
  await page.getByRole('button', { name: /Terminou/ }).click();
  const t2 = await until(page, async () => b.queue[1].status === 'playing', 20000);
  expect(t2 >= 0, `"Terminou" não passou para a próxima: ${statuses(b)}`);
  expect(b.queue[0].status === 'done', 'a do YouTube deveria ficar como cantada');
  await ctx.close();
});

await test('internet cai bem no fim da música: a fila anda assim que volta', async () => {
  const b = makeBackend();
  b.add('Ana', 'vidAAAAAAA1', { duration: 10 });
  b.add('Bia', 'vidBBBBBBB2');
  const { page, ctx } = await openTv(b);
  await page.evaluate(() => (window.__yt.dur.vidAAAAAAA1 = 10));
  await until(page, async () => (await yt(page)).time > 6, 30000);
  b.playerMode = 'fail';
  b.restDown = true;
  await run(page, 30000); // song ends during the outage
  expect(b.queue[0].status === 'playing', 'sem internet nada deveria mudar no servidor');
  b.playerMode = 'ok';
  b.restDown = false;
  const t = await until(page, async () => b.queue[1].status === 'playing' && (await yt(page)).videoId === 'vidBBBBBBB2', 20000);
  expect(t >= 0, `fila travada depois da queda: ${statuses(b)}`);
  expect(b.queue[0].status === 'done', 'a primeira deveria ficar como cantada');
  await ctx.close();
  return `voltou em ${Math.round(t / 1000)} s`;
});

await test('servidor não responde (pedido pendurado): a fila não fica presa', async () => {
  const b = makeBackend();
  b.add('Ana', 'vidAAAAAAA1', { duration: 8 });
  b.add('Bia', 'vidBBBBBBB2');
  const { page, ctx } = await openTv(b);
  await page.evaluate(() => (window.__yt.dur.vidAAAAAAA1 = 8));
  await until(page, async () => (await yt(page)).time > 5, 30000);
  b.playerMode = 'hang';
  await run(page, 8000); // the "end of song" request hangs
  b.playerMode = 'ok';
  const t = await until(page, async () => b.queue[1].status === 'playing', 40000);
  expect(t >= 0, `fila travada: ${statuses(b)}`);
  await ctx.close();
  return `destravou em ${Math.round(t / 1000)} s`;
});

await test('aviso de fim do vídeo se perde: o vigia percebe e avança', async () => {
  const b = makeBackend();
  b.add('Ana', 'vidAAAAAAA1', { duration: 8 });
  b.add('Bia', 'vidBBBBBBB2');
  const { page, ctx } = await openTv(b);
  await page.evaluate(() => ((window.__yt.dur.vidAAAAAAA1 = 8), (window.__yt.behavior.vidAAAAAAA1 = 'noend')));
  const t = await until(page, async () => b.queue[1].status === 'playing', 40000);
  expect(t >= 0, `fila travada: ${statuses(b)}`);
  await ctx.close();
});

await test('fim do vídeo avisado duas vezes: não pula a música seguinte', async () => {
  const b = makeBackend();
  b.add('Ana', 'vidAAAAAAA1', { duration: 6 });
  b.add('Bia', 'vidBBBBBBB2', { duration: 30 });
  b.add('Caio', 'vidCCCCCCC3');
  const { page, ctx } = await openTv(b);
  await page.evaluate(() => ((window.__yt.dur.vidAAAAAAA1 = 6), (window.__yt.dur.vidBBBBBBB2 = 30), (window.__yt.behavior.vidAAAAAAA1 = 'doubleend')));
  await until(page, async () => b.queue[1].status === 'playing', 30000);
  await run(page, 12000);
  expect(b.queue[1].status === 'playing' && b.queue[2].status === 'waiting', `pulou quem não devia: ${statuses(b)}`);
  await ctx.close();
});

await test('vídeo congela no meio (internet oscilou): recarrega no mesmo ponto, sem pular', async () => {
  const b = makeBackend();
  b.add('Ana', 'vidAAAAAAA1', { duration: 60 });
  b.add('Bia', 'vidBBBBBBB2');
  const { page, ctx } = await openTv(b);
  await page.evaluate(() => ((window.__yt.dur.vidAAAAAAA1 = 60), (window.__yt.behavior.vidAAAAAAA1 = ['stall20', 'ok'])));
  const t = await until(page, async () => (await yt(page)).loads.length >= 2, 90000);
  expect(t >= 0, 'não tentou recarregar o vídeo congelado');
  const y = await yt(page);
  expect(y.loads[1].videoId === 'vidAAAAAAA1' && y.loads[1].startSeconds >= 15, `recarregou no ponto errado: ${JSON.stringify(y.loads)}`);
  await until(page, async () => b.queue[0].status === 'done', 90000);
  expect(b.queue[0].status === 'done', `a música deveria terminar normalmente: ${statuses(b)}`);
  await ctx.close();
  return `retomou em ${y.loads[1].startSeconds} s`;
});

await test('vídeo que nunca começa: tenta de novo e depois pula; vários seguidos, para de pular', async () => {
  const b = makeBackend();
  for (const [n, v] of [['Ana', 'deadAAAAAA1'], ['Bia', 'deadBBBBBB2'], ['Caio', 'deadCCCCCC3'], ['Duda', 'deadDDDDDD4']]) b.add(n, v);
  const { page, ctx } = await openTv(b);
  await page.evaluate(() => {
    for (const v of ['deadAAAAAA1', 'deadBBBBBB2', 'deadCCCCCC3', 'deadDDDDDD4']) window.__yt.behavior[v] = 'dead';
  });
  await run(page, 100000);
  expect(b.queue[0].status === 'playing', 'pulou cedo demais (pode ser só um anúncio)');
  expect((await yt(page)).loads.filter((l) => l.videoId === 'deadAAAAAA1').length >= 2, 'não tentou carregar de novo');
  const t = await until(page, async () => b.queue[0].status === 'skipped', 200000, 1000);
  expect(t >= 0, 'vídeo morto nunca foi pulado');
  await until(page, async () => b.queue[1].status === 'skipped', 300000, 1000);
  await run(page, 600000, 1000); // ten more minutes
  expect(b.queue[2].status === 'playing' && b.queue[3].status === 'waiting', `deveria parar de pular depois de dois seguidos: ${statuses(b)}`);
  expect((await page.locator('.toast').textContent())?.includes('internet'), 'sem aviso fixo no telão');
  // the connection comes back: the same song plays and the notice goes away
  await page.evaluate(() => (window.__yt.behavior.deadCCCCCC3 = 'ok'));
  const t2 = await until(page, async () => (await yt(page)).state === 1, 200000, 1000);
  expect(t2 >= 0, 'não voltou a tocar quando o vídeo ficou disponível');
  await run(page, 4000);
  expect((await page.locator('.toast').count()) === 0, 'aviso continuou na tela');
  await ctx.close();
});

await test('clique sem querer no vídeo (pausa): volta a tocar sozinho; pausa do admin é respeitada', async () => {
  const b = makeBackend();
  b.add('Ana', 'vidAAAAAAA1', { duration: 120 });
  const { page, ctx } = await openTv(b);
  await page.evaluate(() => (window.__yt.dur.vidAAAAAAA1 = 120));
  await until(page, async () => (await yt(page)).state === 1, 20000);
  await page.evaluate(() => window.__yt.players.at(-1)._set(2));
  const t = await until(page, async () => (await yt(page)).state === 1, 20000);
  expect(t >= 0, 'ficou pausado para sempre');
  // admin pause
  b.settings.paused = true;
  b.notify('settings');
  await until(page, async () => (await yt(page)).state === 2, 10000);
  await run(page, 60000);
  const y = await yt(page);
  expect(y.state === 2 && y.loads.length === 1, `não respeitou a pausa do admin: ${JSON.stringify(y)}`);
  b.settings.paused = false;
  b.notify('settings');
  expect((await until(page, async () => (await yt(page)).state === 1, 10000)) >= 0, 'não voltou da pausa');
  await ctx.close();
  return `voltou em ${Math.round(t / 1000)} s`;
});

await test('YouTube fora do ar na hora de iniciar: continua tentando até carregar', async () => {
  const b = makeBackend();
  b.ytScriptFailures = 3;
  b.add('Ana', 'vidAAAAAAA1');
  const { page, ctx } = await openTv(b);
  await page.evaluate(() => (window.__yt = { players: [], loads: [], behavior: {}, dur: {}, noReady: 1 }));
  const t = await until(page, async () => (await yt(page)).state === 1, 120000);
  expect(t >= 0, `nunca começou: ${JSON.stringify(await yt(page))}`);
  expect((await yt(page)).players >= 2, 'deveria ter recriado o player que não respondeu');
  await ctx.close();
  return `começou depois de ${Math.round(t / 1000)} s`;
});

await test('banco fora do ar por dois minutos: a música segue e o telão se recupera', async () => {
  const b = makeBackend();
  b.add('Ana', 'vidAAAAAAA1', { duration: 200 });
  const { page, ctx, errors } = await openTv(b);
  await page.evaluate(() => (window.__yt.dur.vidAAAAAAA1 = 200));
  await until(page, async () => (await yt(page)).state === 1, 20000);
  b.restDown = true;
  b.wsMode = 'refuse';
  b.dropSockets();
  await run(page, 120000);
  const y = await yt(page);
  expect(y.state === 1 && y.loads.length === 1, `a música foi interrompida: ${JSON.stringify(y)}`);
  b.add('Bia', 'vidBBBBBBB2'); // joined during the outage
  b.restDown = false;
  b.wsMode = 'ok';
  const t = await until(page, async () => (await page.locator('.side .list li').count()) === 1, 90000);
  expect(t >= 0, 'telão não voltou a atualizar a fila');
  // realtime must be back too: a change shows up fast, without waiting for the 20 s poll
  await until(page, async () => b.sockets.size > 0, 90000);
  await run(page, 3000);
  b.add('Caio', 'vidCCCCCCC3');
  const t2 = await until(page, async () => (await page.locator('.side .list li').count()) === 2, 4000);
  expect(t2 >= 0, 'tempo real não reconectou');
  expect(errors.length === 0, errors.join('; '));
  await ctx.close();
  return `fila voltou em ${Math.round(t / 1000)} s; tempo real ok`;
});

await test('fechar e reabrir o navegador no meio da música: continua de onde parou', async () => {
  const b = makeBackend();
  b.add('Ana', 'vidAAAAAAA1', { duration: 100 });
  b.add('Bia', 'vidBBBBBBB2');
  const { page, ctx } = await openTv(b);
  await page.evaluate(() => (window.__yt.dur.vidAAAAAAA1 = 100));
  await until(page, async () => (await yt(page)).time > 40, 80000);
  await page.reload();
  await run(page, 500);
  // nobody is at the computer: it must start again by itself, no click
  await until(page, async () => (await yt(page)).loads.length === 1, 10000);
  expect((await page.locator('.start-overlay').count()) === 0, 'ficou esperando um clique em "iniciar"');
  const y = await yt(page);
  expect(y.loads[0]?.videoId === 'vidAAAAAAA1' && y.loads[0].startSeconds > 30, `não retomou: ${JSON.stringify(y.loads)}`);
  expect(b.queue[1].status === 'waiting', 'a fila mudou ao reabrir');
  await ctx.close();
  return `retomou em ${Math.round(y.loads[0].startSeconds)} s`;
});

await test('navegador reabre e segura o som sem clique: toca sem som e um clique liga o som', async () => {
  const b = makeBackend();
  b.add('Ana', 'vidAAAAAAA1', { duration: 200 });
  b.add('Bia', 'vidBBBBBBB2', { duration: 200 });
  const { page, ctx } = await openTv(b);
  await page.evaluate(() => (window.__yt.dur.vidAAAAAAA1 = 200));
  await until(page, async () => (await yt(page)).time > 20, 60000);
  // after the reload Chrome holds the sound of this video until someone clicks
  await page.addInitScript(() => {
    const y = (window.__yt = window.__yt || { players: [], loads: [], behavior: {}, dur: {}, noReady: 0 });
    y.behavior.vidAAAAAAA1 = 'soundblocked';
    y.dur.vidAAAAAAA1 = 200;
    // like a fresh Chrome start: nobody has touched this page yet
    Object.defineProperty(navigator, 'userActivation', { get: () => ({ hasBeenActive: false, isActive: false }) });
  });
  await page.reload();
  await until(page, async () => (await yt(page)).state === 1, 20000);
  const p = await page.evaluate(() => { const pl = window.__yt.players.at(-1); return { muted: pl.muted, time: pl.time }; });
  expect(p.muted, `não tocou sem som: ${JSON.stringify(await page.evaluate(() => ({ loads: window.__yt.loads, act: navigator.userActivation?.hasBeenActive })))}`);
  expect((await page.locator('.sound-overlay').count()) === 1, 'não pediu clique para ligar o som');
  await run(page, 150000); // two and a half minutes muted: the watchdog must not skip it
  expect(b.queue[0].status !== 'skipped', `pulou a música tocando sem som: ${statuses(b)}`);
  await page.locator('.sound-overlay').click();
  await run(page, 500);
  const after = await page.evaluate(() => window.__yt.players.at(-1).muted);
  expect(!after && (await page.locator('.sound-overlay').count()) === 0, 'o clique não ligou o som');
  await ctx.close();
  return 'tocou sem som e o clique ligou';
});
await test('admin pula pelo celular e cliques repetidos em "pular": só uma música é pulada por vez', async () => {
  const b = makeBackend();
  for (const [n, v] of [['Ana', 'vidAAAAAAA1'], ['Bia', 'vidBBBBBBB2'], ['Caio', 'vidCCCCCCC3'], ['Duda', 'vidDDDDDDD4']]) b.add(n, v, { duration: 300 });
  const { page, ctx } = await openTv(b);
  await page.evaluate(() => {
    for (const v of ['vidAAAAAAA1', 'vidBBBBBBB2', 'vidCCCCCCC3', 'vidDDDDDDD4']) window.__yt.dur[v] = 300;
  });
  await until(page, async () => (await yt(page)).state === 1, 20000);
  // admin skips from the phone (another device)
  b.advance(b.playing().id, 'skipped');
  await until(page, async () => (await yt(page)).videoId === 'vidBBBBBBB2' && (await yt(page)).state === 1, 20000);
  expect(b.queue[1].status === 'playing', `telão não acompanhou: ${statuses(b)}`);
  // ten fast clicks on the projector's own skip button
  await page.locator('.gear').click();
  const skip = page.getByRole('button', { name: /Pular música/ });
  for (let i = 0; i < 10; i++) await skip.click({ force: true, noWaitAfter: true }).catch(() => {});
  await run(page, 6000);
  expect(b.queue[2].status === 'playing' && b.queue[3].status === 'waiting', `cliques repetidos pularam demais: ${statuses(b)}`);
  await ctx.close();
});

await test('sessão do admin expira no telão: pede a senha em vez de travar em silêncio', async () => {
  const b = makeBackend();
  b.add('Ana', 'vidAAAAAAA1', { duration: 6 });
  b.add('Bia', 'vidBBBBBBB2');
  const { page, ctx } = await openTv(b);
  await page.evaluate(() => (window.__yt.dur.vidAAAAAAA1 = 6));
  await until(page, async () => (await yt(page)).state === 1, 20000);
  b.playerMode = '401';
  const t = await until(page, async () => (await page.locator('input[type=password]').count()) === 1, 30000);
  expect(t >= 0, 'continuou no telão sem conseguir avançar a fila');
  await ctx.close();
});

await test('telão abre sem internet: espera e entra sozinho quando a internet volta', async () => {
  const b = makeBackend();
  b.add('Ana', 'vidAAAAAAA1');
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  await page.clock.install();
  await wire(page, b);
  let down = true;
  await page.route('**/api/admin/login', (route) => (down ? route.abort('internetdisconnected') : route.fallback()));
  await page.goto(BASE + '/');
  await run(page, 10000);
  expect((await page.locator('input[type=password]').count()) === 0, 'caiu na tela de senha só porque a internet falhou');
  down = false;
  const t = await until(page, async () => (await page.locator('.start-overlay').count()) === 1, 15000);
  expect(t >= 0, 'não entrou quando a internet voltou');
  await ctx.close();
});

await test('erro inesperado na tela: ela se reconstrói sozinha e a música continua', async () => {
  const b = makeBackend();
  b.add('Ana', 'vidAAAAAAA1', { duration: 100 });
  const { page, ctx } = await openTv(b);
  await page.evaluate(() => (window.__yt.dur.vidAAAAAAA1 = 100));
  await until(page, async () => (await yt(page)).time > 20, 60000);
  // corrupt data from the database makes the render throw once
  const bad = b.settings;
  b.settings = { ...bad, tv_message: { boom: true } };
  b.notify('settings');
  await run(page, 1500);
  b.settings = bad;
  const t = await until(page, async () => (await yt(page)).state === 1 && (await page.locator('.tv').count()) === 1, 40000);
  expect(t >= 0, `tela não voltou: ${await page.locator('body').innerText()}`);
  const y = await yt(page);
  expect(y.videoId === 'vidAAAAAAA1' && y.time > 15, `não retomou a música: ${JSON.stringify(y)}`);
  expect((await page.locator('.start-overlay').count()) === 0, 'pediu o clique de novo');
  await ctx.close();
  return `voltou em ${Math.round(t / 1000)} s`;
});

await test('noite longa: 300 músicas seguidas sem vazar memória nem acumular lixo na tela', async () => {
  const b = makeBackend();
  b.settings.intermission_sec = 1;
  const { page, ctx, errors } = await openTv(b);
  const cdp = await ctx.newCDPSession(page);
  const heap = async () => {
    await cdp.send('HeapProfiler.collectGarbage');
    const m = await cdp.send('Runtime.getHeapUsage');
    return m.usedSize / 1e6;
  };
  const dom = () => page.evaluate(() => document.getElementsByTagName('*').length);
  const feed = (n) => {
    for (let i = 0; i < n; i++) b.add(`Cantor ${b.nextId}`, `song${String(b.nextId).padStart(7, '0')}`, { duration: 20 });
  };
  feed(50);
  await until(page, async () => b.queue.filter((q) => q.status === 'done').length >= 50, 3000000, 1000);
  const h1 = await heap();
  const d1 = await dom();
  feed(250);
  const t = await until(page, async () => b.queue.every((q) => q.status === 'done'), 15000000, 1000);
  expect(t >= 0, `parou no meio: ${b.queue.filter((q) => q.status === 'done').length} de 300`);
  await run(page, 5000);
  const h2 = await heap();
  const d2 = await dom();
  const y = await yt(page);
  expect(y.players === 1, `criou ${y.players} players`);
  expect(y.loads.length === 300, `carregou ${y.loads.length} vídeos para 300 músicas`);
  expect(d2 <= d1 + 20, `elementos na tela cresceram de ${d1} para ${d2}`);
  expect(h2 < h1 + 15, `memória cresceu de ${h1.toFixed(1)} MB para ${h2.toFixed(1)} MB`);
  expect(errors.length === 0, errors.join('; '));
  await ctx.close();
  return `memória ${h1.toFixed(1)} MB depois de 50 músicas, ${h2.toFixed(1)} MB depois de 300`;
});

await test('fila enorme (400 pessoas): o telão continua atualizando', async () => {
  const b = makeBackend();
  for (let i = 0; i < 400; i++) b.add(`Pessoa ${i}`, `big${String(i).padStart(8, '0')}`);
  const { page, ctx } = await openTv(b);
  // real servers refuse very long addresses: make the mock do the same
  await page.route(/fake\.supabase\.co\/rest\/v1\/singers/, (route) =>
    route.request().url().length > 8000 ? route.fulfill({ status: 414, contentType: 'application/json', body: '{"message":"URI too long"}' }) : route.fallback(),
  );
  await page.reload();
  await run(page, 3000);
  expect((await page.locator('.side .list li').count()) === 8, 'a fila não apareceu');
  await ctx.close();
});

await test('resultado do campeonato no telão: a próxima música espera calada e toca quando o admin tira', async () => {
  const b = makeBackend();
  b.settings.results_contest_id = 7;
  b.add('Ana', 'vidAAAAAAA1', { duration: 30 });
  const { page, ctx } = await openTv(b);
  await run(page, 15000);
  const y = await yt(page);
  expect(y.loads.length === 1 && y.loads[0].cue && y.state !== 1, `tocou por baixo do resultado: ${JSON.stringify(y)}`);
  await run(page, 400000); // results stay up for a long time: nobody gets skipped
  expect(b.queue[0].status === 'playing', 'pulou a pessoa enquanto o resultado estava na tela');
  b.settings.results_contest_id = null;
  b.notify('settings');
  const t = await until(page, async () => (await yt(page)).state === 1, 10000);
  expect(t >= 0, 'não começou depois que o resultado saiu');
  await ctx.close();
});

await test('botões do telão: pausar, voltar ao início e pular', async () => {
  const b = makeBackend();
  b.add('Ana', 'vidAAAAAAA1', { duration: 200 });
  b.add('Bia', 'vidBBBBBBB2', { duration: 200 });
  const { page, ctx, errors } = await openTv(b);
  await page.evaluate(() => ((window.__yt.dur.vidAAAAAAA1 = 200), (window.__yt.dur.vidBBBBBBB2 = 200)));
  await until(page, async () => (await yt(page)).time > 30, 60000);
  await page.getByRole('button', { name: 'Pausar' }).click();
  expect((await until(page, async () => (await yt(page)).state === 2, 5000)) >= 0, 'não pausou');
  await run(page, 30000);
  expect((await yt(page)).state === 2, 'voltou a tocar sozinho durante a pausa');
  await page.getByRole('button', { name: 'Continuar' }).click();
  expect((await until(page, async () => (await yt(page)).state === 1, 5000)) >= 0, 'não continuou');
  await page.getByRole('button', { name: 'Voltar ao início da música' }).click();
  expect((await until(page, async () => (await yt(page)).time < 10, 5000)) >= 0, 'não voltou ao início');
  expect(b.queue[0].status === 'playing', 'trocou de música ao voltar');
  const skip = page.getByRole('button', { name: 'Pular para a próxima' });
  for (let i = 0; i < 6; i++) await skip.click({ force: true, timeout: 500 }).catch(() => {});
  await until(page, async () => (await yt(page)).videoId === 'vidBBBBBBB2' && (await yt(page)).state === 1, 20000);
  expect(b.queue[0].status === 'skipped' && b.queue[1].status === 'playing', `pulo errado: ${statuses(b)}`);
  expect(errors.length === 0, errors.join('; '));
  await ctx.close();
});

await test('telão: botão de adicionar pedido coloca a pessoa na fila; desligado nas configurações, some', async () => {
  const b = makeBackend();
  const { page, ctx, errors } = await openTv(b);
  await page.getByRole('button', { name: 'Adicionar pedido' }).click();
  await page.getByPlaceholder('Nome').fill('Dona Lúcia');
  await page.getByRole('searchbox').fill('evidencias');
  await page.getByRole('button', { name: 'Buscar' }).click();
  await run(page, 1000);
  await page.getByRole('button', { name: 'Adicionar', exact: true }).click();
  await run(page, 1500);
  expect(b.queue.length === 1 && Object.values(b.singers)[0].name === 'Dona Lúcia', `não entrou na fila: ${statuses(b)}`);
  expect((await page.locator('.add-card .ok').count()) === 1, 'não confirmou na tela');
  await page.getByRole('button', { name: 'Fechar' }).click();
  expect((await until(page, async () => (await yt(page)).state === 1, 30000)) >= 0, 'a música adicionada não tocou');
  b.settings.tv_add_enabled = false;
  b.notify('settings');
  await run(page, 2000);
  expect((await page.getByRole('button', { name: 'Adicionar pedido' }).count()) === 0, 'o botão continuou na tela');
  expect(errors.length === 0, errors.join('; '));
  await ctx.close();
});

await test('duas músicas por pessoa: a segunda fica de reserva e entra no fim da fila depois que a pessoa canta', async () => {
  const b = makeBackend();
  b.settings.songs_per_person = 2;
  const { page, ctx, errors } = await openPhone(b);
  const pickOne = async (label) => {
    await page.getByRole('searchbox').fill('evidencias');
    await page.getByRole('button', { name: 'Buscar' }).click();
    await run(page, 1000);
    await page.getByRole('button', { name: label, exact: true }).click();
    await new Promise((r) => setTimeout(r, 500)); // the fake server takes 300 ms of real time
    await run(page, 2500);
  };
  await pickOne('Cantar');
  expect(b.queue.length === 1, 'a primeira não entrou na fila');
  await pickOne('Guardar');
  expect(b.reserves.length === 1 && b.queue.length === 1, `a segunda deveria ser reserva: fila ${b.queue.length}, reservas ${b.reserves.length}`);
  expect((await page.getByText('Sua próxima música').count()) === 1, 'o celular não mostrou a reserva');
  expect((await page.getByRole('searchbox').count()) === 0, 'deixou escolher uma terceira com limite 2');
  // other people join, then Zeca sings
  b.add('Ana', 'vidAAAAAAA1');
  b.add('Bia', 'vidBBBBBBB2');
  let cur = b.advance(null, 'done'); // Zeca playing
  cur = b.advance(cur, 'done'); // Zeca done -> reserve joins the end
  await run(page, 3000);
  const order = b.queue.filter((q) => ['playing', 'waiting'].includes(q.status)).sort((x, y) => (x.status === 'playing' ? -1 : y.status === 'playing' ? 1 : x.position - y.position)).map((q) => b.singers[q.singer_id].name).join(',');
  expect(order === 'Ana,Bia,Zeca', `ordem errada: ${order}`);
  expect(b.reserves.length === 0, 'a reserva não saiu da reserva');
  expect((await until(page, async () => (await page.getByText('pessoa na sua frente').count()) === 1, 5000)) >= 0, 'o celular não mostrou a música na fila');
  expect((await page.getByText('Sua próxima música').count()) === 0, 'a reserva continuou aparecendo');
  expect(errors.length === 0, errors.join('; '));
  await ctx.close();
});

async function openPhone(b) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.clock.install();
  await wire(page, b);
  await page.goto(BASE + '/cantar');
  await run(page, 500);
  await page.getByPlaceholder('Seu nome').fill('Zeca');
  await page.getByRole('button', { name: 'Bora cantar' }).click();
  await run(page, 1500);
  return { page, ctx, errors };
}

await test('celular: toque duplo em "Cantar" coloca uma música só', async () => {
  const b = makeBackend();
  const { page, ctx, errors } = await openPhone(b);
  await page.getByRole('searchbox').fill('evidencias');
  await page.getByRole('button', { name: 'Buscar' }).click();
  await run(page, 1000);
  const pick = page.getByRole('button', { name: 'Cantar' });
  await pick.click();
  for (let i = 0; i < 5; i++) await pick.click({ force: true, timeout: 300 }).catch(() => {});
  await run(page, 3000);
  expect(b.queuePosts === 1, `mandou ${b.queuePosts} pedidos`);
  expect(b.queue.filter((q) => q.status === 'waiting').length === 1, 'fila com música repetida');
  expect(await page.locator('.mysong').isVisible(), 'não mostrou a música na fila');
  expect(errors.length === 0, errors.join('; '));
  await ctx.close();
});

await test('celular: busca que não responde avisa e deixa tentar de novo', async () => {
  const b = makeBackend();
  b.searchMode = 'hang';
  const { page, ctx } = await openPhone(b);
  await page.getByRole('searchbox').fill('evidencias');
  await page.getByRole('button', { name: 'Buscar' }).click();
  const t = await until(page, async () => (await page.locator('.search .error').count()) === 1, 60000);
  expect(t >= 0, 'ficou girando para sempre');
  b.searchMode = 'ok';
  await page.getByRole('button', { name: 'Buscar' }).click();
  await run(page, 1500);
  expect((await page.getByRole('button', { name: 'Cantar' }).count()) === 1, 'a segunda busca não funcionou');
  await ctx.close();
  return `avisou em ${Math.round(t / 1000)} s`;
});

await test('celular com internet lenta e bar cheio: a fila na tela não fica parada', async () => {
  const b = makeBackend();
  b.add('Ana', 'vidAAAAAAA1');
  b.advance(null, 'done');
  const { page, ctx } = await openPhone(b);
  b.restDelay = 1500; // every answer from the database takes 1.5 s (real time)
  // people keep joining: one change every 400 ms for 12 s
  let n = 0;
  const feed = setInterval(() => b.add(`Pessoa ${++n}`, `crowd${String(n).padStart(6, '0')}`), 400);
  let seenDuring = 0;
  for (let i = 0; i < 48; i++) {
    await page.clock.runFor(250);
    await new Promise((r) => setTimeout(r, 250));
    seenDuring = Math.max(seenDuring, await page.locator('.line li').count());
  }
  clearInterval(feed);
  expect(seenDuring >= 8, `a tela só mostrou ${seenDuring} pessoas enquanto ${n} entravam`);
  await ctx.close();
  return `${seenDuring - 1} de ${n} pessoas já apareciam durante o movimento`;
});

await test('telão abre no dia seguinte: a fila da noite passada é limpa antes de qualquer música tocar', async () => {
  const b = makeBackend();
  b.add('Ontem 1', 'oldAAAAAAA1');
  b.add('Ontem 2', 'oldBBBBBBB2');
  b.advance(null, 'done'); // one was even left "playing" when the PC was turned off
  b.nightMode = 'reset';
  const { page, ctx, errors } = await openTv(b);
  await run(page, 20000);
  expect((await yt(page)).loads.length === 0, `tocou música da noite passada: ${JSON.stringify((await yt(page)).loads)}`);
  expect(b.queue.every((q) => q.status === 'skipped'), `fila não foi limpa: ${statuses(b)}`);
  // and tonight's first song plays normally
  b.add('Hoje', 'newAAAAAAA1');
  expect((await until(page, async () => (await yt(page)).videoId === 'newAAAAAAA1' && (await yt(page)).state === 1, 30000)) >= 0, 'a primeira música da noite não tocou');
  expect(errors.length === 0, errors.join('; '));
  await ctx.close();
});

await test('conferência da noite não responde: o karaokê começa mesmo assim', async () => {
  const b = makeBackend();
  b.add('Ana', 'vidAAAAAAA1');
  b.nightMode = 'hang';
  const { page, ctx, errors } = await openTv(b);
  const t = await until(page, async () => (await yt(page)).state === 1, 40000);
  expect(t >= 0, 'a música nunca começou');
  expect(errors.length === 0, errors.join('; '));
  await ctx.close();
  return `começou em ${Math.round(t / 1000)} s`;
});

await test('ranking da noite: a nota aparece no fim da música, some sozinha e a próxima toca', async () => {
  const b = makeBackend();
  Object.assign(b.settings, { ranking_enabled: true, ranking_on_tv: false, night_started_at: new Date(0).toISOString() });
  const first = b.add('Ana', 'vidAAAAAAA1');
  b.add('Bia', 'vidBBBBBBB2');
  const { page, ctx, errors } = await openTv(b);
  expect((await until(page, async () => (await yt(page)).videoId === 'vidAAAAAAA1' && (await yt(page)).state === 1, 30000)) >= 0, 'a primeira não tocou');
  first.score = 8.7; // what the database trigger would write when the song ends
  first.vote_count = 12;
  expect((await until(page, async () => (await page.locator('.score-card').count()) === 1, 40000)) >= 0, 'a nota não apareceu');
  await run(page, 600);
  await shot(page, 'tv-nota');
  const text = await page.locator('.score-card').textContent();
  expect(text.includes('8,7') && text.includes('Ana'), `nota errada na tela: ${text}`);
  expect((await until(page, async () => (await page.locator('.score-card').count()) === 0, 12000)) >= 0, 'a nota ficou presa na tela');
  expect((await until(page, async () => (await yt(page)).videoId === 'vidBBBBBBB2' && (await yt(page)).state === 1, 30000)) >= 0, 'a segunda não tocou');
  // admin opens the night ranking on the projector: the video waits, and closing it resumes
  b.settings.ranking_on_tv = true;
  b.notify('settings');
  expect((await until(page, async () => (await page.locator('.results-screen').count()) === 1 && (await yt(page)).state === 2, 10000)) >= 0, 'o ranking não abriu ou o vídeo não esperou');
  await shot(page, 'tv-ranking');
  expect((await page.locator('.results-screen').textContent()).includes('Ana'), 'ranking sem a líder');
  await page.getByRole('button', { name: 'Fechar o ranking' }).click();
  expect((await until(page, async () => (await page.locator('.results-screen').count()) === 0 && (await yt(page)).state === 1, 10000)) >= 0, 'não voltou a tocar depois de fechar o ranking');
  expect(errors.length === 0, errors.join('; '));
  await ctx.close();
});

await test('GIFs e figurinhas no telão: aparecem, somem sozinhos e endereço estranho é ignorado', async () => {
  const b = makeBackend();
  b.settings.gifs_enabled = true;
  b.add('Ana', 'vidAAAAAAA1', { duration: 300 });
  const { page, ctx, errors } = await openTv(b);
  await page.evaluate(() => (window.__yt.dur.vidAAAAAAA1 = 300));
  await page.route(/giphy\.com/, (route) => route.fulfill({ contentType: 'image/gif', body: Buffer.from('R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==', 'base64') }));
  await until(page, async () => (await yt(page)).state === 1, 30000);
  b.insert('tv_gifs', { id: 1, kind: 'gif', ref: 'https://evil.example.com/x.gif', name: 'Mal' });
  b.insert('tv_gifs', { id: 2, kind: 'sticker', ref: 'nao-existe', name: 'Mal' });
  await run(page, 1000);
  expect((await page.locator('.gif-pop').count()) === 0, 'mostrou um GIF de endereço não permitido');
  b.insert('tv_gifs', { id: 3, kind: 'sticker', ref: 'bis', name: 'Zeca' });
  for (let i = 4; i < 30; i++) b.insert('tv_gifs', { id: i, kind: 'gif', ref: 'https://media1.giphy.com/media/abc/200.gif', name: 'Bia' });
  expect((await until(page, async () => (await page.locator('.gif-pop .sticker').count()) === 1, 3000)) >= 0, 'a figurinha não apareceu');
  await run(page, 500);
  await shot(page, 'tv-figurinha');
  expect((await page.locator('.gif-pop').textContent()).includes('Zeca mandou'), 'sem o nome de quem mandou');
  expect((await until(page, async () => (await page.locator('.gif-pop img').count()) === 1, 10000)) >= 0, 'o GIF não apareceu depois da figurinha');
  // the burst of 26 was cut to a short line: everything is gone within a minute, video untouched
  expect((await until(page, async () => (await page.locator('.gif-pop').count()) === 0, 60000)) >= 0, 'GIFs ficaram presos na tela');
  expect((await yt(page)).state === 1 && (await yt(page)).loads.length === 1, 'os GIFs atrapalharam o vídeo');
  expect(errors.length === 0, errors.join('; '));
  await ctx.close();
});

await test('engrenagem do vídeo: velocidade, legenda e controles do YouTube sem perder o ponto da música', async () => {
  const b = makeBackend();
  b.add('Ana', 'vidAAAAAAA1', { duration: 300 });
  b.add('Bia', 'vidBBBBBBB2', { duration: 300 });
  const { page, ctx, errors } = await openTv(b);
  await page.evaluate(() => ((window.__yt.dur.vidAAAAAAA1 = 300), (window.__yt.dur.vidBBBBBBB2 = 300)));
  await until(page, async () => (await yt(page)).time > 40, 80000);
  await page.getByRole('button', { name: 'Opções do vídeo' }).click();
  await page.getByRole('button', { name: '0,75×' }).click();
  await shot(page, 'tv-engrenagem');
  await page.getByRole('button', { name: 'Desligada' }).click();
  await run(page, 3000);
  expect((await yt(page)).state === 1, 'mexer em velocidade/legenda parou o vídeo');
  const before = await yt(page);
  await page.getByRole('button', { name: 'Escolher no YouTube' }).click();
  expect((await until(page, async () => (await yt(page)).players === before.players + 1 && (await yt(page)).state === 1, 30000)) >= 0, 'o vídeo não voltou depois de ligar os controles do YouTube');
  const after = await yt(page);
  const last = after.loads[after.loads.length - 1];
  expect(last.videoId === 'vidAAAAAAA1' && last.startSeconds > 30, `não voltou no mesmo ponto: ${JSON.stringify(last)}`);
  expect((await page.locator('.player-wrap.interactive').count()) === 1, 'o vídeo não ficou clicável');
  expect(b.queue[0].status === 'playing', `mexeu na fila: ${statuses(b)}`);
  // next song: YouTube's controls go away by themselves and the song plays from the start
  await page.getByRole('button', { name: 'Pular para a próxima' }).click();
  expect((await until(page, async () => (await yt(page)).videoId === 'vidBBBBBBB2' && (await yt(page)).state === 1, 40000)) >= 0, 'a próxima não tocou');
  expect((await page.locator('.player-wrap.interactive').count()) === 0, 'os controles do YouTube continuaram ligados');
  expect(errors.length === 0, errors.join('; '));
  await ctx.close();
});

await test('celular: ranking da noite e figurinha pro telão', async () => {
  const b = makeBackend();
  Object.assign(b.settings, { ranking_enabled: true, gifs_enabled: true, night_started_at: new Date(0).toISOString() });
  const done = b.add('Ana', 'vidAAAAAAA1');
  Object.assign(done, { status: 'done', score: 9.1, vote_count: 7 });
  const { page, ctx, errors } = await openPhone(b);
  expect((await until(page, async () => (await page.getByText('Ranking da noite').count()) === 1, 5000)) >= 0, 'sem ranking no celular');
  await shot(page, 'celular-ranking');
  expect((await page.locator('.ranking').textContent()).includes('9,1'), 'ranking sem a nota');
  await page.getByRole('button', { name: 'Mandar GIF ou figurinha pro telão' }).click();
  await run(page, 500);
  await shot(page, 'celular-gif');
  await page.getByRole('button', { name: /Bis! Bis!/ }).click();
  await run(page, 1000);
  expect(b.apiCalls.some((c) => c.path === '/api/gif' && c.method === 'POST' && c.body.sticker === 'bis'), 'a figurinha não foi enviada');
  expect((await page.locator('.sheet').count()) === 0, 'a folha de GIFs não fechou');
  expect(errors.length === 0, errors.join('; '));
  await ctx.close();
});

await test('selfie: aparece no telão (vez da pessoa, palco e fila) e banco sem a atualização não quebra nada', async () => {
  const b = makeBackend();
  b.settings.photos_enabled = true;
  const ana = b.add('Ana', 'vidAAAAAAA1');
  b.add('Bia', 'vidBBBBBBB2');
  b.singers[ana.singer_id].photo_at = new Date().toISOString();
  b.settings.intermission_sec = 4;
  const { page, ctx, errors } = await openTv(b);
  expect((await until(page, async () => (await page.locator('.intro .avatar').count()) === 1, 15000)) >= 0, 'a foto não apareceu na chamada da vez');
  await shot(page, 'tv-selfie-vez');
  expect((await until(page, async () => (await yt(page)).state === 1, 20000)) >= 0, 'a música não tocou');
  expect((await page.locator('.side .now .avatar').count()) === 1, 'sem foto em "No palco agora"');
  // Bia has no selfie: a drawing instead of a photo, never an empty circle
  expect((await page.locator('.side .list img.avatar').count()) === 0, 'Bia não tem foto e apareceu uma');
  expect((await page.locator('.side .list .avatar.fun').count()) === 1, 'Bia sem foto ficou sem desenho');
  await ctx.close();

  // same night, database without update 006: the select with photo_at fails, the screen keeps working
  const old = makeBackend();
  old.noPhotoColumn = true;
  old.add('Caio', 'vidCCCCCCC3');
  const tv = await openTv(old);
  expect((await until(tv.page, async () => (await yt(tv.page)).videoId === 'vidCCCCCCC3' && (await yt(tv.page)).state === 1, 30000)) >= 0, 'sem a coluna nova o telão não tocou');
  expect((await tv.page.locator('.side .now').textContent()).includes('Caio'), 'sem o nome de quem canta');
  expect(errors.length === 0 && tv.errors.length === 0, errors.concat(tv.errors).join('; '));
  await tv.ctx.close();
});

await test('celular: tirar selfie manda uma foto pequena, mostra no celular e dá pra apagar', async () => {
  const b = makeBackend();
  b.settings.photos_enabled = true;
  const { page, ctx, errors } = await openPhone(b);
  expect((await until(page, async () => (await page.getByText('Quer aparecer no telão?').count()) === 1, 5000)) >= 0, 'sem convite pra selfie');
  await shot(page, 'celular-selfie-convite');
  await page.locator('.selfie-card input[type=file]').setInputFiles((await import('url')).fileURLToPath(new URL('./fixtures-selfie.jpg', import.meta.url)));
  expect((await until(page, async () => (b.photoPosts ?? []).length === 1, 8000, 100)) >= 0, 'a foto não foi enviada');
  const sent = b.photoPosts[0];
  expect(sent.startsWith('data:image/jpeg;base64,') && sent.length < 110000, `foto em formato errado (${sent.slice(0, 30)}…, ${sent.length} letras)`);
  expect((await until(page, async () => (await page.getByText('Sua foto tá no telão').count()) === 1, 5000)) >= 0, 'o celular não mostrou a foto');
  expect((await page.locator('.topbar .avatar').count()) === 1, 'sem foto ao lado do nome');
  await shot(page, 'celular-selfie');
  await page.getByRole('button', { name: 'Apagar minha foto' }).click();
  expect((await until(page, async () => (await page.getByText('Sua foto tá no telão').count()) === 0, 5000)) >= 0, 'a foto não saiu');
  expect(b.apiCalls.some((c) => c.path === '/api/photo' && c.method === 'DELETE'), 'não pediu para apagar');
  expect(errors.length === 0, errors.join('; '));
  await ctx.close();
});

await test('celular: cliente de outra noite tira selfie e a foto aparece na hora no próprio celular', async () => {
  const b = makeBackend();
  b.settings.photos_enabled = true;
  const { page, ctx, errors } = await openPhone(b);
  // the public read (migration 008) only lists people from tonight: this phone's own row never comes
  await page.route(/fake\.supabase\.co\/rest\/v1\/singers/, (route) =>
    route.request().method() === 'GET' ? route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }) : route.fallback(),
  );
  expect((await until(page, async () => (await page.getByText('Quer aparecer no telão?').count()) === 1, 5000)) >= 0, 'sem convite pra selfie');
  await page.locator('.selfie-card input[type=file]').setInputFiles((await import('url')).fileURLToPath(new URL('./fixtures-selfie.jpg', import.meta.url)));
  expect((await until(page, async () => (b.photoPosts ?? []).length === 1, 8000, 100)) >= 0, 'a foto não foi enviada');
  expect((await until(page, async () => (await page.getByText('Sua foto tá no telão').count()) === 1, 5000)) >= 0, 'a foto não apareceu no celular de quem voltou');
  await page.getByRole('button', { name: 'Apagar minha foto' }).click();
  expect((await until(page, async () => (await page.getByText('Sua foto tá no telão').count()) === 0, 5000)) >= 0, 'a foto não saiu');
  expect(errors.length === 0, errors.join('; '));
  await ctx.close();
});

await test('celular: link do YouTube colado vira o resultado, com aviso quando não parece karaokê', async () => {
  const b = makeBackend();
  const { page, ctx, errors } = await openPhone(b);
  await page.getByRole('searchbox').fill('https://youtu.be/linkAAAAAA1');
  await page.getByRole('button', { name: 'Buscar' }).click();
  await run(page, 1000);
  expect((await page.locator('.results li').count()) === 1, 'o link não virou resultado');
  expect((await page.getByText('não parece versão karaokê').count()) === 1, 'sem aviso de que não parece karaokê');
  await shot(page, 'celular-link');
  await page.getByRole('button', { name: 'Cantar' }).click();
  await settle();
  expect((await until(page, async () => b.queue.some((q) => q.video_id === 'linkAAAAAA1'), 5000, 100)) >= 0, 'a música do link não entrou na fila');
  expect(errors.length === 0, errors.join('; '));
  await ctx.close();
});

await test('celular: depois de cantar, a figurinha com a nota fica pronta pra compartilhar', async () => {
  const b = makeBackend();
  Object.assign(b.settings, { ranking_enabled: true, photos_enabled: true, night_started_at: new Date(0).toISOString() });
  const { page, ctx, errors } = await openPhone(b);
  b.singers[b.me.id].photo_at = new Date().toISOString();
  b.queue.push({ id: b.nextId++, singer_id: b.me.id, video_id: 'mineAAAAAA1', title: 'Evidências (Karaokê Version) - Chitãozinho', thumbnail: null, duration_sec: 200, status: 'playing', position: 1, created_at: new Date().toISOString(), started_at: new Date().toISOString() });
  b.notify('queue');
  expect((await until(page, async () => (await page.getByText('Você tá no palco').count()) === 1, 5000)) >= 0, 'o celular não viu a pessoa no palco');
  const mine = b.queue[b.queue.length - 1];
  Object.assign(mine, { status: 'done', score: 9.3, vote_count: 11 });
  b.notify('queue');
  expect((await until(page, async () => (await page.locator('.sticker-ready').textContent().catch(() => '')).includes('9,3'), 20000)) >= 0, 'a nota não chegou no celular');
  await shot(page, 'celular-figurinha-pronta');
  await page.getByRole('button', { name: 'Ver minha figurinha' }).click();
  expect((await until(page, async () => (await page.locator('.sticker-img').count()) === 1, 8000, 100)) >= 0, 'a figurinha não foi desenhada');
  const size = await page.locator('.sticker-img').evaluate((img) => [img.naturalWidth, img.naturalHeight].join('x'));
  expect(size === '1080x1350', `tamanho errado: ${size}`);
  await shot(page, 'celular-figurinha');
  if (process.env.SHOTS) {
    const png = await page.locator('.sticker-img').evaluate(async (img) => {
      const r = await fetch(img.src);
      const buf = new Uint8Array(await r.arrayBuffer());
      let s = '';
      for (const x of buf) s += String.fromCharCode(x);
      return btoa(s);
    });
    (await import('fs')).writeFileSync(`${process.env.SHOTS}/figurinha.png`, Buffer.from(png, 'base64'));
  }
  expect((await page.getByRole('link', { name: 'Salvar imagem' }).count()) === 1, 'sem botão de salvar');
  expect(errors.length === 0, errors.join('; '));
  await ctx.close();
});

// ---------------------------------------------------------------- correções da revisão (13/11)

await test('dois telões abertos: o segundo vira espelho, não corta a música e pode assumir', async () => {
  const b = makeBackend();
  b.add('Ana', 'vidAAAAAAA1', { duration: 200 });
  b.add('Bia', 'vidBBBBBBB2', { duration: 200 });
  const one = await openTv(b);
  await one.page.evaluate(() => ((window.__yt.dur.vidAAAAAAA1 = 200), (window.__yt.dur.vidBBBBBBB2 = 200)));
  await until(one.page, async () => (await yt(one.page)).state === 1, 20000);
  // a phone logged in as admin opens the projector address too
  const two = await openTv(b, { click: false });
  await run(two.page, 3000);
  expect((await two.page.locator('.mirror-overlay').count()) === 1, 'o segundo telão não virou espelho');
  expect((await yt(two.page)).players === 0, 'o segundo telão criou um player');
  await run(two.page, 60000);
  await run(one.page, 3000);
  expect(b.queue[0].status === 'playing', `a música do primeiro telão foi cortada: ${statuses(b)}`);
  expect(!b.playerCalls.some((c) => c.tv && c.tv !== b.tvOwner), 'o espelho mexeu na fila');
  // the projector PC died: the phone takes over
  await two.page.getByRole('button', { name: 'Assumir o telão aqui' }).click();
  await run(two.page, 2000);
  expect((await two.page.locator('.mirror-overlay').count()) === 0, 'não assumiu');
  expect((await until(two.page, async () => (await yt(two.page)).state === 1, 20000)) >= 0, 'o telão novo não tocou');
  await run(one.page, 10000); // next heartbeat of the old one
  expect((await one.page.locator('.mirror-overlay').count()) === 1, 'o telão antigo não virou espelho');
  expect(one.errors.length === 0 && two.errors.length === 0, one.errors.concat(two.errors).join('; '));
  await one.ctx.close();
  await two.ctx.close();
});

await test('reabriu sem clique e o vídeo demorou (falso alarme): o som volta sozinho', async () => {
  const b = makeBackend();
  b.add('Ana', 'vidAAAAAAA1', { duration: 200 });
  const { page, ctx } = await openTv(b);
  await page.evaluate(() => (window.__yt.dur.vidAAAAAAA1 = 200));
  await until(page, async () => (await yt(page)).time > 20, 60000);
  await page.addInitScript(() => {
    const y = (window.__yt = window.__yt || { players: [], loads: [], behavior: {}, dur: {}, noReady: 0 });
    y.behavior.vidAAAAAAA1 = 'late'; // slow internet: 15 s to start, the sound is NOT blocked
    y.dur.vidAAAAAAA1 = 200;
    Object.defineProperty(navigator, 'userActivation', { get: () => ({ hasBeenActive: false, isActive: false }) });
  });
  await page.reload();
  const t = await until(page, async () => (await yt(page)).state === 1, 40000);
  expect(t >= 0, 'não tocou');
  await run(page, 6000);
  const muted = await page.evaluate(() => window.__yt.players.at(-1).muted);
  expect(!muted, 'ficou sem som depois do falso alarme');
  expect((await page.locator('.sound-overlay').count()) === 0, 'o aviso de som continuou na tela');
  await ctx.close();
});

await test('contagem em 0: o "terminou" da música anterior não encerra a próxima', async () => {
  const b = makeBackend();
  b.settings.intermission_sec = 0;
  b.add('Ana', 'vidAAAAAAA1', { duration: 8 });
  b.add('Bia', 'staleBBBBB2', { duration: 60 });
  const { page, ctx } = await openTv(b);
  await page.evaluate(() => ((window.__yt.dur.vidAAAAAAA1 = 8), (window.__yt.dur.staleBBBBB2 = 60), (window.__yt.behavior.staleBBBBB2 = 'staleend')));
  await until(page, async () => b.queue[1].status === 'playing', 30000);
  await run(page, 15000);
  expect(b.queue[1].status === 'playing', `a música da Bia foi encerrada antes de tocar: ${statuses(b)}`);
  expect((await yt(page)).state === 1, 'a música da Bia não tocou');
  await ctx.close();
});

await test('ranking esquecido no telão com gente na fila: sai sozinho em 3 minutos', async () => {
  const b = makeBackend();
  b.settings.ranking_enabled = true;
  b.add('Ana', 'vidAAAAAAA1', { duration: 30 });
  const { page, ctx } = await openTv(b);
  await page.evaluate(() => (window.__yt.dur.vidAAAAAAA1 = 30));
  await until(page, async () => (await yt(page)).state === 1, 20000);
  b.settings.ranking_on_tv = true;
  b.add('Bia', 'vidBBBBBBB2', { duration: 30 });
  b.notify('settings');
  await run(page, 2000);
  expect(await page.locator('.results-screen').isVisible(), 'o ranking não apareceu');
  await run(page, 175000);
  expect(b.settings.ranking_on_tv === true, 'fechou cedo demais');
  await run(page, 8000);
  expect(b.settings.ranking_on_tv === false, 'o ranking não saiu sozinho');
  await ctx.close();
});

await test('celular: trocar a música mantém o lugar na fila', async () => {
  const b = makeBackend();
  b.add('Ana', 'vidAAAAAAA1', { duration: 200 });
  const { page, ctx, errors } = await openPhone(b);
  await page.getByRole('searchbox').fill('evidencias');
  await page.getByRole('button', { name: 'Buscar' }).click();
  await run(page, 1000);
  await page.getByRole('button', { name: 'Cantar' }).click();
  await settle();
  await run(page, 2000);
  b.add('Caio', 'vidCCCCCCC3', { duration: 200 });
  const mine = b.queue.find((q) => q.singer_id === b.me.id);
  const before = mine.position;
  await page.getByRole('button', { name: 'Trocar a música' }).click();
  await page.locator('.mysong').getByRole('searchbox').fill('outra');
  await page.locator('.mysong').getByRole('button', { name: 'Buscar' }).click();
  await run(page, 1000);
  await page.getByRole('button', { name: 'Trocar', exact: true }).click();
  await run(page, 2000);
  expect(b.swaps === 1, 'não trocou');
  expect(b.queue.filter((q) => q.singer_id === b.me.id).length === 1 && mine.position === before, 'perdeu o lugar na fila');
  expect((await page.getByRole('button', { name: 'Trocar a música' }).count()) === 1, 'o celular não voltou ao normal');
  expect(errors.length === 0, errors.join('; '));
  await ctx.close();
});

// ---------------------------------------------------------------- correções da revisão 2 (13/11)

for (const startedBefore of [false, true]) {
  await test(`internet do projetor pisca 30 s com outro telão aberto${startedBefore ? ' (que já tocou antes)' : ''}: o projetor continua no comando`, async () => {
    const b = makeBackend();
    b.add('Ana', 'vidAAAAAAA1', { duration: 400 });
    b.add('Bia', 'vidBBBBBBB2', { duration: 400 });
    b.settings.max_duration_sec = 600;
    const one = await openTv(b);
    await one.page.evaluate(() => ((window.__yt.dur.vidAAAAAAA1 = 400), (window.__yt.dur.vidBBBBBBB2 = 400)));
    await until(one.page, async () => (await yt(one.page)).state === 1, 20000);
    const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const p2 = await ctx2.newPage();
    if (startedBefore) await p2.addInitScript(() => localStorage.setItem('karaoke_started', '1'));
    await p2.clock.install();
    await wire(p2, b, { admin: true });
    await p2.goto(BASE + '/');
    await run(p2, 3000);
    expect((await p2.locator('.mirror-overlay').count()) === 1, 'o segundo não virou espelho');
    await run(p2, 130000); // the second screen has been open a while
    await run(one.page, 3000);
    // the projector's heartbeats are lost for a little over 30 s (internet blinked)
    b.tvSeen = Date.now() - 31000;
    await run(p2, 9000);
    await run(one.page, 9000); // projector back online: next heartbeat
    expect((await p2.locator('.mirror-overlay').count()) === 1, 'o segundo telão assumiu sozinho');
    expect((await one.page.locator('.mirror-overlay').count()) === 0, 'o projetor perdeu o comando');
    expect((await yt(one.page)).state === 1, 'a música parou no projetor');
    expect(b.queue[0].status === 'playing', `a música foi cortada: ${statuses(b)}`);
    await one.ctx.close();
    await ctx2.close();
  });
}

await test('projetor reabre (Chrome fechou e abriu): espera o telão antigo liberar e volta a tocar sozinho', async () => {
  const b = makeBackend();
  b.add('Ana', 'vidAAAAAAA1', { duration: 400 });
  b.settings.max_duration_sec = 600;
  const one = await openTv(b);
  await one.page.evaluate(() => (window.__yt.dur.vidAAAAAAA1 = 400));
  await until(one.page, async () => (await yt(one.page)).state === 1, 20000);
  await one.ctx.close(); // Chrome closed: the old screen's lock is still fresh
  const ctx2 = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const p2 = await ctx2.newPage();
  const errors = [];
  p2.on('pageerror', (e) => errors.push(e.message));
  await p2.addInitScript(() => localStorage.setItem('karaoke_started', '1'));
  await p2.clock.install();
  await wire(p2, b, { admin: true });
  await p2.goto(BASE + '/');
  await run(p2, 3000);
  expect((await p2.locator('.mirror-overlay').textContent().catch(() => '')).includes('Esperando'), 'não avisou que está esperando o telão anterior');
  b.tvSeen = Date.now() - 31000; // the old lock ran out
  await run(p2, 9000);
  expect((await p2.locator('.mirror-overlay').count()) === 0, 'o projetor reaberto não voltou a ser o telão');
  expect((await until(p2, async () => (await yt(p2)).state === 1, 30000)) >= 0, 'não voltou a tocar');
  expect(errors.length === 0, errors.join('; '));
  await ctx2.close();
});

await test('"Duplicar aba" no telão: a aba nova vira espelho, não um segundo telão no comando', async () => {
  const b = makeBackend();
  b.add('Ana', 'vidAAAAAAA1', { duration: 400 });
  b.settings.max_duration_sec = 600;
  const one = await openTv(b);
  await one.page.evaluate(() => (window.__yt.dur.vidAAAAAAA1 = 400));
  await until(one.page, async () => (await yt(one.page)).state === 1, 20000);
  const id = await one.page.evaluate(() => sessionStorage.getItem('karaoke_tv_id'));
  // same browser, the copied tab brings the same id in its sessionStorage
  const p2 = await one.ctx.newPage();
  await p2.addInitScript((v) => sessionStorage.setItem('karaoke_tv_id', v), id);
  await p2.clock.install();
  await wire(p2, b, { admin: true });
  await p2.goto(BASE + '/');
  for (let i = 0; i < 12; i++) {
    await run(one.page, 250);
    await run(p2, 250);
  }
  const id2 = await p2.evaluate(() => sessionStorage.getItem('karaoke_tv_id'));
  expect(id2 && id2 !== id, 'a aba duplicada ficou com o mesmo id do telão');
  expect((await p2.locator('.mirror-overlay').count()) === 1, 'a aba duplicada não virou espelho');
  expect((await yt(p2)).players === 0, 'a aba duplicada criou um player');
  await run(one.page, 9000);
  expect((await one.page.locator('.mirror-overlay').count()) === 0 && (await yt(one.page)).state === 1, 'o telão original perdeu o comando');
  await one.ctx.close();
});

await test('admin: quem foi recusado numa noite anterior continua na lista e pode ser liberado', async () => {
  const b = makeBackend();
  b.oldBlocked = [{ id: '00000000-0000-4000-8000-00000000abcd', name: 'Recusado Semana Passada', status: 'blocked', created_at: '2026-11-01T23:00:00Z' }];
  const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.clock.install();
  await wire(page, b, { admin: true });
  await page.goto(BASE + '/admin');
  await run(page, 2000);
  if (process.env.SHOTS) await page.screenshot({ path: `${process.env.SHOTS}/admin-topo.png`, fullPage: true });
  await page.locator('details', { hasText: 'Recusados' }).locator('summary').click().catch(() => {});
  await run(page, 300);
  expect((await page.getByText('Recusado Semana Passada').count()) >= 1, 'o recusado antigo não aparece no admin');
  expect(errors.length === 0, errors.join('; '));
  await ctx.close();
});

await test('celular: depois de zerar a noite, o "Mandou bem" da noite anterior some sozinho', async () => {
  const b = makeBackend();
  Object.assign(b.settings, { ranking_enabled: true, night_started_at: new Date(Date.now() - 3600e3).toISOString() });
  const { page, ctx, errors } = await openPhone(b);
  b.queue.push({ id: b.nextId++, singer_id: b.me.id, video_id: 'mineAAAAAA1', title: 'Evidências (Karaokê Version)', thumbnail: null, duration_sec: 200, status: 'playing', position: 1, created_at: new Date().toISOString(), started_at: new Date().toISOString() });
  b.notify('queue');
  expect((await until(page, async () => (await page.getByText('Você tá no palco').count()) === 1, 5000)) >= 0, 'o celular não viu a pessoa no palco');
  const mine = b.queue[b.queue.length - 1];
  Object.assign(mine, { status: 'done', score: 5, vote_count: 3 });
  b.notify('queue');
  expect((await until(page, async () => (await page.getByText('Mandou bem').count()) === 1, 20000)) >= 0, 'o "Mandou bem" não apareceu');
  // admin: "Zerar a noite"
  b.settings.night_started_at = new Date().toISOString();
  b.notify('settings');
  expect((await until(page, async () => (await page.getByText('Mandou bem').count()) === 0, 5000)) >= 0, 'o "Mandou bem" ficou depois de zerar a noite');
  await page.reload();
  await run(page, 2000);
  expect((await page.getByText('Mandou bem').count()) === 0, 'o "Mandou bem" voltou depois de recarregar');
  expect(errors.length === 0, errors.join('; '));
  await ctx.close();
});

// ---------------------------------------------------------------- correções do teste no Chrome (14/11)

await test('telão tocando sem som (esperando clique): o botão "Pular" pula de verdade', async () => {
  const b = makeBackend();
  b.add('Ana', 'vidAAAAAAA1', { duration: 200 });
  b.add('Bia', 'vidBBBBBBB2', { duration: 200 });
  const { page, ctx } = await openTv(b);
  await page.evaluate(() => (window.__yt.dur.vidAAAAAAA1 = 200));
  await until(page, async () => (await yt(page)).time > 20, 60000);
  await page.addInitScript(() => {
    const y = (window.__yt = window.__yt || { players: [], loads: [], behavior: {}, dur: {}, noReady: 0 });
    y.behavior.vidAAAAAAA1 = 'soundblocked';
    y.dur.vidAAAAAAA1 = 200;
    Object.defineProperty(navigator, 'userActivation', { get: () => ({ hasBeenActive: false, isActive: false }) });
  });
  await page.reload();
  await until(page, async () => (await page.locator('.sound-overlay').count()) === 1, 30000);
  expect((await page.locator('.sound-overlay').count()) === 1, 'não ficou no modo sem som');
  await page.getByRole('button', { name: 'Pular para a próxima' }).click();
  await run(page, 1500);
  expect(b.queue[0].status === 'skipped', `o botão Pular não pulou: ${statuses(b)}`);
  expect(!(await page.evaluate(() => window.__yt.players.at(-1).muted)), 'o clique no botão não ligou o som');
  await ctx.close();
});

await test('celular: GIFs prontos para escolher e mandar, sem busca configurada', async () => {
  const b = makeBackend();
  Object.assign(b.settings, { gifs_enabled: true });
  const { page, ctx, errors } = await openPhone(b);
  await page.route(/giphy\.com/, (route) => route.fulfill({ contentType: 'image/gif', body: Buffer.from('R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==', 'base64') }));
  b.add('Ana', 'vidAAAAAAA1');
  b.advance(null, 'done');
  await run(page, 1500);
  await page.getByRole('button', { name: 'Mandar GIF ou figurinha pro telão' }).click();
  await run(page, 800);
  const n = await page.locator('.gif-grid.presets button').count();
  expect(n >= 15, `poucos GIFs prontos: ${n}`);
  await shot(page, 'celular-gifs-prontos');
  await page.locator('.gif-grid.presets').getByRole('button', { name: 'Palmas', exact: true }).click();
  await run(page, 1000);
  expect(b.apiCalls.some((c) => c.path === '/api/gif' && c.method === 'POST' && c.body.preset === 'Rgn6cUfaN5zW'), 'o GIF pronto não foi enviado');
  expect((await page.locator('.sheet').count()) === 0, 'a folha de GIFs não fechou');
  expect(errors.length === 0, errors.join('; '));
  await ctx.close();
});

await test('celular: ranking da noite mostra as 5 carinhas e a nota vai pro voto', async () => {
  const b = makeBackend();
  Object.assign(b.settings, { ranking_enabled: true, night_started_at: new Date(0).toISOString() });
  const ana = b.add('Ana', 'vidAAAAAAA1', { duration: 200 });
  b.advance(null, 'done');
  const { page, ctx, errors } = await openPhone(b);
  expect((await until(page, async () => (await page.getByText('Ranking da noite · sua nota').count()) === 1, 5000)) >= 0, 'as carinhas não apareceram no ranking da noite');
  await page.getByRole('radio', { name: 'Arrasou' }).click();
  await run(page, 800);
  expect(b.votes?.some((v) => v.queueId === ana.id && v.score === 5), 'o voto não foi enviado');
  expect((await page.getByRole('radio', { name: 'Arrasou' }).getAttribute('aria-checked')) === 'true', 'a carinha escolhida não ficou marcada');
  await shot(page, 'celular-voto-noite');
  expect(errors.length === 0, errors.join('; '));
  await ctx.close();
});

await test('celular: vibra e toca uns 10 s antes da vez e de novo quando chega a vez', async () => {
  const b = makeBackend();
  b.settings.intermission_sec = 2;
  const { page, ctx, errors } = await openPhone(b);
  await page.evaluate(() => {
    window.__vib = [];
    navigator.vibrate = (p) => (window.__vib.push(JSON.stringify(p)), true);
  });
  const now = await page.evaluate(() => Date.now());
  const ana = b.add('Ana', 'vidAAAAAAA1', { duration: 30 });
  Object.assign(ana, { status: 'playing', started_at: new Date(now).toISOString() });
  b.queue.push({
    id: b.nextId++, singer_id: b.me.id, video_id: 'vidZECA0001', title: 'Evidências (karaoke)', thumbnail: null,
    duration_sec: 40, status: 'waiting', position: 999, created_at: new Date().toISOString(), started_at: null,
  });
  b.notify('queue');
  expect((await until(page, async () => (await page.getByText('Você é o próximo!').count()) === 1, 5000)) >= 0, 'o celular não mostrou que é o próximo');
  await shot(page, 'celular-proximo');
  const vib = () => page.evaluate(() => window.__vib.slice());
  await run(page, 12000); // ~13 s into a 30 s song + 2 s countdown: still too early
  expect((await vib()).length === 0, `vibrou cedo demais: ${await vib()}`);
  const t = await until(page, async () => (await vib()).length > 0, 15000);
  expect(t >= 0, 'não vibrou antes da vez');
  expect((await vib())[0] === '[250,120,250]', `vibração errada antes da vez: ${await vib()}`);
  b.advance(ana.id, 'done');
  expect((await until(page, async () => (await vib()).length > 1, 5000)) >= 0, 'não vibrou quando chegou a vez');
  expect((await vib())[1] === '[400,150,400,150,700]', `vibração errada na vez: ${await vib()}`);
  await run(page, 3000);
  expect((await vib()).length === 2, `vibrou mais vezes do que devia: ${await vib()}`);
  expect(errors.length === 0, errors.join('; '));
  await ctx.close();
});

await test('celular: segunda música em destaque e a busca vem antes da fila', async () => {
  const b = makeBackend();
  b.settings.songs_per_person = 2;
  b.add('Ana', 'vidAAAAAAA1', { duration: 200 });
  b.advance(null, 'done');
  const { page, ctx, errors } = await openPhone(b);
  await page.getByRole('searchbox').fill('evidencias');
  await page.getByRole('button', { name: 'Buscar' }).click();
  await run(page, 1000);
  await page.getByRole('button', { name: 'Cantar', exact: true }).click();
  await new Promise((r) => setTimeout(r, 500)); // the fake server takes 300 ms of real time
  await run(page, 2500);
  expect((await until(page, async () => (await page.locator('.next-song').count()) === 1, 5000)) >= 0, 'sem o cartão da próxima música');
  const order = await page.evaluate(() => {
    const y = (sel) => document.querySelector(sel)?.getBoundingClientRect().top ?? -1;
    return { mine: y('.mysong'), next: y('.next-song'), line: y('ol.line') };
  });
  expect(order.mine < order.next && order.next < order.line, `ordem errada na tela: ${JSON.stringify(order)}`);
  await shot(page, 'celular-segunda-musica');
  expect(errors.length === 0, errors.join('; '));
  await ctx.close();
});

await test('telão: opção do admin esconde e mostra o "líder da noite"', async () => {
  const b = makeBackend();
  Object.assign(b.settings, { ranking_enabled: true, leader_on_tv: true, night_started_at: new Date(0).toISOString() });
  const done = b.add('Ana', 'vidAAAAAAA1');
  Object.assign(done, { status: 'done', score: 9.1, vote_count: 7 });
  const { page, ctx, errors } = await openTv(b);
  expect((await until(page, async () => (await page.getByText('Líder da noite: Ana').count()) === 1, 5000)) >= 0, 'o líder não apareceu com a opção ligada');
  b.settings.leader_on_tv = false;
  b.notify('settings');
  expect((await until(page, async () => (await page.locator('.tv-message.ranking-on').count()) === 0, 5000)) >= 0, 'o líder continuou com a opção desligada');
  expect(errors.length === 0, errors.join('; '));
  await ctx.close();
});

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} de ${results.length} cenários passaram.`);
process.exit(failed.length ? 1 : 0);

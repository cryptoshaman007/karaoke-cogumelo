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
      if (typeof mode === 'string' && mode.startsWith('error')) { set(S.UNSTARTED); return fire('onError', Number(mode.slice(5))); }
      if (typeof mode === 'string' && mode.startsWith('stall')) p.stallAt = Number(mode.slice(5));
      set(S.BUFFERING);
      setTimeout(() => !p.destroyed && p.videoId === videoId && p.state === S.BUFFERING && p.stallAt !== -1 && set(S.PLAYING), 300);
    };
    p.loadVideoById = (o) => start(o.videoId, o.startSeconds, false);
    p.cueVideoById = (o) => start(o.videoId, o.startSeconds, true);
    p.playVideo = () => { if ([S.PAUSED, S.CUED].includes(p.state)) set(S.PLAYING); };
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
      b.notify('queue');
      return next?.id ?? null;
    },
    notify(table) {
      for (const s of b.sockets) s.push(table);
    },
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
    if (table === 'queue') {
      body = b.queue.filter((q) => ['waiting', 'playing'].includes(q.status)).sort((x, y) => x.position - y.position || x.id - y.id);
    } else if (table === 'settings') body = single ? b.settings : [b.settings];
    else if (table === 'singers') {
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
    if (path === '/api/player') {
      b.playerCalls.push({ ...body, mode: b.playerMode });
      if (b.playerMode === 'fail') return route.abort('internetdisconnected');
      if (b.playerMode === 'hang') return; // never answers
      if (b.playerMode === '401') return json({ error: 'Faça login no admin' }, 401);
      return json({ playing: b.advance(body.current ?? null, body.endStatus === 'skipped' ? 'skipped' : 'done') });
    }
    if (path === '/api/popular') return json({ songs: [] });
    if (path === '/api/join') {
      const sid = `00000000-0000-4000-9000-${String(b.nextId++).padStart(12, '0')}`;
      b.singers[sid] = { id: sid, name: body.name, status: 'approved', created_at: new Date().toISOString() };
      b.me = b.singers[sid];
      return json({ token: 'tok', singer: b.me });
    }
    if (path === '/api/me') return json({ singer: b.me });
    if (path === '/api/search') {
      if (b.searchMode === 'hang') return;
      return json({ results: [{ videoId: 'pickAAAAAA1', title: 'Evidências (karaoke)', thumbnail: '', durationSec: 200, channel: 'Canal' }] });
    }
    if (path === '/api/queue' && req.method() === 'POST') {
      b.queuePosts++;
      await new Promise((r) => setTimeout(r, 300));
      if (b.queue.some((q) => q.singer_id === b.me.id && ['waiting', 'playing'].includes(q.status))) {
        return json({ error: 'Você já tem uma música na fila. Espere ela tocar!' }, 409);
      }
      b.queue.push({
        id: b.nextId++, singer_id: b.me.id, video_id: body.videoId, title: body.title, thumbnail: null, duration_sec: body.durationSec,
        status: 'waiting', position: b.nextId, created_at: new Date().toISOString(), started_at: null,
      });
      b.notify('queue');
      return json({ ok: true });
    }
    return json({ error: 'not mocked' }, 404);
  });

  // Supabase Realtime (Phoenix protocol, vsn 2.0.0: [join_ref, ref, topic, event, payload])
  await page.routeWebSocket(/fake\.supabase\.co\/realtime/, (ws) => {
    if (b.wsMode === 'refuse') return ws.close();
    const topics = new Map();
    const sock = {
      push(table) {
        for (const [topic, binds] of topics) {
          const ids = binds.filter((x) => x.table === table).map((x) => x.id);
          if (!ids.length) continue;
          const data = { type: 'UPDATE', schema: 'public', table, commit_timestamp: new Date().toISOString(), columns: [], record: {}, old_record: {}, errors: null };
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

await test('vídeo bloqueado para embed: pula sozinho e avisa', async () => {
  const b = makeBackend();
  b.add('Ana', 'blockedAAA1');
  b.add('Bia', 'vidBBBBBBB2');
  const { page, ctx } = await openTv(b);
  await page.evaluate(() => (window.__yt.behavior.blockedAAA1 = 'error150'));
  const t = await until(page, async () => b.queue[1].status === 'playing', 30000);
  expect(t >= 0, `não passou para a próxima: ${statuses(b)}`);
  expect(b.queue[0].status === 'skipped', 'a bloqueada deveria ficar como pulada');
  expect((await page.locator('.toast').textContent())?.includes('não pôde ser tocado'), 'sem aviso no telão');
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
  await page.locator('.start-overlay').click();
  await until(page, async () => (await yt(page)).loads.length === 1, 10000);
  const y = await yt(page);
  expect(y.loads[0]?.videoId === 'vidAAAAAAA1' && y.loads[0].startSeconds > 30, `não retomou: ${JSON.stringify(y.loads)}`);
  expect(b.queue[1].status === 'waiting', 'a fila mudou ao reabrir');
  await ctx.close();
  return `retomou em ${Math.round(y.loads[0].startSeconds)} s`;
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
  await page.getByRole('button', { name: 'Continuar' }).click();
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

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} de ${results.length} cenários passaram.`);
process.exit(failed.length ? 1 : 0);

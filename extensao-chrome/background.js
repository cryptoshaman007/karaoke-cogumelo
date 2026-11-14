// Karaokê Cogumelo – Telão. Opens the YouTube window for the projector, keeps track of it, closes it.
// State lives in chrome.storage.session because Chrome may stop this worker between messages.

const KEY = 'job';

async function getJob() {
  const d = await chrome.storage.session.get(KEY);
  return d[KEY] || null; // { queueId, videoId, windowId, ytTabId, telaoTabId, ended }
}
async function setJob(job) {
  if (job) await chrome.storage.session.set({ [KEY]: job });
  else await chrome.storage.session.remove(KEY);
}

function toTelao(job, msg) {
  if (!job || job.telaoTabId == null) return;
  chrome.tabs.sendMessage(job.telaoTabId, { ...msg, queueId: job.queueId }).catch(() => {});
}

async function closeWindow(job) {
  if (job && job.windowId != null) {
    try {
      await chrome.windows.remove(job.windowId);
    } catch {}
  }
}

function clampInt(n, min, max) {
  n = Math.round(Number(n));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}

async function open(msg, sender) {
  const old = await getJob();
  if (old) {
    // a new song: the old window goes away first (it never says "ended" for this song)
    await setJob(null);
    await closeWindow(old);
  }
  const id = String(msg.videoId || '');
  if (!/^[A-Za-z0-9_-]{6,20}$/.test(id)) return;
  const t = clampInt(msg.start, 0, 24 * 3600);
  const from = t > 0 ? `&t=${t}s` : '';
  const url = msg.mode === 'video' ? `https://www.youtube.com/watch_popup?v=${id}${from}` : `https://www.youtube.com/watch?v=${id}${from}`;
  const r = msg.rect || {};
  const bounds = { left: clampInt(r.x, -10000, 10000), top: clampInt(r.y, -10000, 10000), width: clampInt(r.w, 200, 10000), height: clampInt(r.h, 150, 10000) };
  const job = { queueId: msg.queueId, videoId: id, windowId: null, ytTabId: null, telaoTabId: sender.tab ? sender.tab.id : null, ended: false };
  await setJob(job);
  try {
    const win = await chrome.windows.create({ url, type: 'popup', focused: true, ...bounds });
    const cur = await getJob();
    if (!cur || cur.queueId !== msg.queueId) {
      // another song came in while the window was opening
      try {
        await chrome.windows.remove(win.id);
      } catch {}
      return;
    }
    cur.windowId = win.id;
    cur.ytTabId = win.tabs && win.tabs[0] ? win.tabs[0].id : null;
    await setJob(cur);
    toTelao(cur, { type: 'opened' });
  } catch (e) {
    await setJob(null);
    toTelao(job, { type: 'error', reason: String(e && e.message ? e.message : e) });
  }
}

async function finish(reason) {
  const job = await getJob();
  if (!job) return;
  await setJob(null);
  toTelao(job, { type: reason }); // 'ended' (video finished) or 'closed' (window closed by hand)
  await closeWindow(job);
}

async function command(msg) {
  const job = await getJob();
  if (!job || job.ytTabId == null || job.queueId !== msg.queueId) return;
  chrome.tabs.sendMessage(job.ytTabId, { type: 'cmd', cmd: msg.cmd, value: msg.value }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    if (!msg || typeof msg !== 'object') return reply(null);
    // from the projector page (telao.js)
    if (msg.type === 'open') await open(msg, sender);
    else if (msg.type === 'close') {
      const job = await getJob();
      if (job && (msg.queueId == null || job.queueId === msg.queueId)) {
        await setJob(null);
        await closeWindow(job);
      }
    } else if (msg.type === 'cmd') await command(msg);
    // from the YouTube window (youtube.js)
    else if (msg.type === 'yt-hello') {
      const job = await getJob();
      const mine = !!job && sender.tab && sender.tab.id === job.ytTabId;
      return reply(mine ? { managed: true, videoId: job.videoId } : { managed: false });
    } else if (msg.type === 'yt-status') {
      const job = await getJob();
      if (job && sender.tab && sender.tab.id === job.ytTabId) toTelao(job, { type: 'status', ...msg.status });
    } else if (msg.type === 'yt-ended') {
      const job = await getJob();
      if (job && sender.tab && sender.tab.id === job.ytTabId) await finish('ended');
    }
    reply(null);
  })();
  return true;
});

// the YouTube window was closed by hand: the projector moves on
chrome.windows.onRemoved.addListener(async (windowId) => {
  const job = await getJob();
  if (job && job.windowId === windowId) await finish('closed');
});

// the projector tab went away: its YouTube window goes too
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const job = await getJob();
  if (job && job.telaoTabId === tabId) {
    await setJob(null);
    await closeWindow(job);
  }
});

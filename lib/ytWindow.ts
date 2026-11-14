// Some karaoke channels (KaraFun and others) do not let their videos play inside another site
// (YouTube errors 101/150). Those videos still play on youtube.com itself. So when the projector
// hits one, it opens youtube.com in a separate window placed exactly over the video area, and the
// queue on the right stays visible.
//
// The projector cannot see inside that window (another site), so the next song waits for a click on
// "Terminou" (or Pular). And as soon as YouTube loads, Chrome cuts the link between the two
// windows (YouTube's Cross-Origin-Opener-Policy): from then on `win.closed` reads true and the
// window can no longer be closed, moved or reused from here. Pular, pause and restart cannot reach
// it; a Chrome extension would be needed for that.
//
// Chrome blocks windows opened without a click. On the projector PC either start Chrome with
// --disable-popup-blocking, or allow pop-ups for the site once. If the window is still blocked,
// the screen shows a button that opens it with a click.

const WINDOW_NAME = 'karaoke-youtube';
const MODE_KEY = 'karaoke_yt_window_mode';

/** 'page' = the normal youtube.com page; 'video' = YouTube's bare player page (only the video). */
export type YtWindowMode = 'page' | 'video';

export function readYtMode(): YtWindowMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'video' ? 'video' : 'page';
  } catch {
    return 'page';
  }
}

export function saveYtMode(mode: YtWindowMode) {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {}
}

/** YouTube's error codes for "the owner does not allow this video outside youtube.com". */
export const isEmbedBlocked = (code: unknown) => [101, 150].includes(Number(code));

export function ytWatchUrl(videoId: string, startSeconds: number, mode: YtWindowMode): string {
  const id = encodeURIComponent(videoId);
  const t = Math.max(0, Math.floor(startSeconds));
  const from = t > 0 ? `&t=${t}s` : '';
  return mode === 'video' ? `https://www.youtube.com/watch_popup?v=${id}${from}` : `https://www.youtube.com/watch?v=${id}${from}`;
}

/** The screen rectangle (in screen pixels) of an element of this page. */
export function screenRect(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  const border = Math.max(0, (window.outerWidth - window.innerWidth) / 2);
  const top = Math.max(0, window.outerHeight - window.innerHeight - border);
  const x = (window.screenX ?? window.screenLeft ?? 0) + border + r.left;
  const y = (window.screenY ?? window.screenTop ?? 0) + top + r.top;
  return { x: Math.round(x), y: Math.round(y), w: Math.round(r.width), h: Math.round(r.height) };
}

/**
 * Opens (or reuses) the YouTube window over `area` and loads the video. Returns null when Chrome
 * blocked the window. The window first opens blank (same site as this page), so it can be moved
 * and sized exactly before going to YouTube.
 */
export function openYtWindow(area: HTMLElement | null, videoId: string, startSeconds: number, mode: YtWindowMode): Window | null {
  const rect = area ? screenRect(area) : { x: 0, y: 0, w: Math.round(window.innerWidth * 0.75), h: Math.round(window.innerHeight) };
  const features = `popup=yes,left=${rect.x},top=${rect.y},width=${rect.w},height=${rect.h}`;
  let win: Window | null = null;
  try {
    win = window.open('about:blank', WINDOW_NAME, features);
  } catch {
    win = null;
  }
  if (!win) return null;
  try {
    // the size given to window.open is the inside of the window: make the whole window fit the area
    win.moveTo(rect.x, rect.y);
    win.resizeTo(rect.w, rect.h);
  } catch {}
  try {
    win.location.href = ytWatchUrl(videoId, startSeconds, mode);
  } catch {
    return null;
  }
  try {
    win.focus();
  } catch {}
  return win;
}

export function closeYtWindow(win: Window | null | undefined) {
  try {
    if (win && !win.closed) win.close();
  } catch {}
}

export function focusYtWindow(win: Window | null | undefined) {
  try {
    if (win && !win.closed) win.focus();
  } catch {}
}

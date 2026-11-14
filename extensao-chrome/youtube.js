// Runs on youtube.com. Does something only in the window the extension opened for the projector:
// tells the projector where the video is, and that it ended.
(async () => {
  let info;
  try {
    info = await chrome.runtime.sendMessage({ type: 'yt-hello' });
  } catch {
    return;
  }
  if (!info || !info.managed) return;
  const expected = info.videoId;
  let ended = false;
  let everPlayed = false;

  const player = () => document.getElementById('movie_player');
  const video = () => document.querySelector('#movie_player video, video.html5-main-video, video');
  const currentId = () => {
    try {
      return new URL(location.href).searchParams.get('v');
    } catch {
      return null;
    }
  };

  function end() {
    if (ended) return;
    ended = true;
    chrome.runtime.sendMessage({ type: 'yt-ended' }).catch(() => {});
  }

  setInterval(() => {
    if (ended) return;
    // YouTube moved on to another video by itself (autoplay): the song is over
    const id = currentId();
    if (everPlayed && id && id !== expected) return end();
    const v = video();
    if (!v) return;
    const ad = !!player()?.classList.contains('ad-showing');
    const duration = Number(v.duration) || 0;
    const time = Number(v.currentTime) || 0;
    if (!ad && time > 1 && !v.paused) everPlayed = true;
    chrome.runtime
      .sendMessage({ type: 'yt-status', status: { time, duration, paused: !!v.paused, ad } })
      .catch(() => {});
    if (!ad && everPlayed && (v.ended || (duration > 0 && time >= duration - 0.5 && v.paused))) end();
  }, 1000);

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.type !== 'cmd') return;
    const v = video();
    if (!v) return;
    try {
      if (msg.cmd === 'pause') v.pause();
      else if (msg.cmd === 'play') v.play().catch(() => {});
      else if (msg.cmd === 'restart') {
        v.currentTime = 0;
        v.play().catch(() => {});
      } else if (msg.cmd === 'volume') v.volume = Math.max(0, Math.min(1, Number(msg.value) / 100));
    } catch {}
  });
})();

'use client';
/**
 * Heads-up on the singer's phone: a buzz plus a little chime, made on the spot with Web Audio
 * (no sound file to download). Phones only let a page make sound after the person touched it at
 * least once, so `unlockSound` runs on the first touch and the chime works from then on while the
 * page stays open. iPhones do not vibrate from a web page; there the chime is the warning.
 */
type Ctx = AudioContext;
let ctx: Ctx | null = null;

function audio(): Ctx | null {
  if (typeof window === 'undefined') return null;
  if (ctx) return ctx;
  const AC = (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) as
    | typeof AudioContext
    | undefined;
  if (!AC) return null;
  try {
    ctx = new AC();
  } catch {
    ctx = null;
  }
  return ctx;
}

/** Call from a touch/click: wakes the audio up so later chimes (fired by a timer) can play. */
export function unlockSound() {
  const c = audio();
  if (!c) return;
  try {
    if (c.state === 'suspended') void c.resume();
    // a silent blip: some phones only count audio as allowed once something really played
    const g = c.createGain();
    g.gain.value = 0;
    const o = c.createOscillator();
    o.connect(g).connect(c.destination);
    o.start();
    o.stop(c.currentTime + 0.02);
  } catch {}
}

function note(c: Ctx, freq: number, at: number, len: number, vol: number) {
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = 'triangle';
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(vol, at + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, at + len);
  o.connect(g).connect(c.destination);
  o.start(at);
  o.stop(at + len + 0.05);
}

/** 'soon': about 10 seconds to go. 'now': it is this person's turn. */
export function turnAlert(kind: 'soon' | 'now') {
  try {
    navigator.vibrate?.(kind === 'now' ? [400, 150, 400, 150, 700] : [250, 120, 250]);
  } catch {}
  const c = audio();
  if (!c) return;
  try {
    if (c.state === 'suspended') void c.resume();
    const t = c.currentTime + 0.05;
    // two notes for "get ready", a happy little arpeggio (twice) for "your turn"
    const tune = kind === 'now' ? [523.25, 659.25, 783.99, 1046.5] : [659.25, 880];
    const reps = kind === 'now' ? 2 : 1;
    let at = t;
    for (let r = 0; r < reps; r++) {
      for (const f of tune) {
        note(c, f, at, 0.28, 0.35);
        at += 0.16;
      }
      at += 0.35;
    }
  } catch {}
}

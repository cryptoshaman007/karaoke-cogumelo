/* eslint-disable @next/next/no-img-element */
'use client';
import { useState } from 'react';

// Who has no selfie gets a little drawing instead, so the projector never shows an empty circle.
// The drawing comes from the person's id: always the same one for the same person, all night.
// Only emojis that old phones also draw (no newer animals that show up as an empty box).
const FACES = ['🐸', '🐱', '🐶', '🦊', '🐼', '🐨', '🐯', '🦁', '🐷', '🐵', '🐙', '🦄', '🐔', '🐧', '🐰', '🐻', '🐹', '🦖', '🐳', '🦉', '🐮', '🐢', '🐞', '🐬', '🐝', '🐠', '🐲', '👽', '👻', '🤖'];

function pick(seed: string) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return { face: FACES[h % FACES.length], hue: (h >>> 8) % 360 };
}

/**
 * A round selfie. Without a photo (or if it fails to load): a cute drawing picked from `seed`
 * (the singer id), or nothing when no seed is given.
 */
export default function Avatar({ src, size = 40, className = '', seed }: { src: string | null; size?: number; className?: string; seed?: string | null }) {
  const [broken, setBroken] = useState<string | null>(null);
  if (!src || broken === src) {
    if (!seed) return null;
    const { face, hue } = pick(seed);
    return (
      <span
        className={`avatar fun ${className}`.trim()}
        aria-hidden="true"
        style={{ width: size, height: size, fontSize: Math.round(size * 0.6), background: `hsl(${hue} 55% 28%)` }}
      >
        <span>{face}</span>
      </span>
    );
  }
  return (
    <img
      className={`avatar ${className}`.trim()}
      src={src}
      alt=""
      width={size}
      height={size}
      style={{ width: size, height: size }}
      loading="lazy"
      onError={() => setBroken(src)}
    />
  );
}

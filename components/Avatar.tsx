/* eslint-disable @next/next/no-img-element */
'use client';
import { useState } from 'react';

/** A round selfie. Renders nothing when there is no photo or it fails to load. */
export default function Avatar({ src, size = 40, className = '' }: { src: string | null; size?: number; className?: string }) {
  const [broken, setBroken] = useState<string | null>(null);
  if (!src || broken === src) return null;
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

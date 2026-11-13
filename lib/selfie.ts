'use client';

/** Size of the square selfie sent to the server, in pixels. */
const SIDE = 320;

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve(img); // the browser already turns the photo upright (EXIF)
    img.onerror = () => reject(new Error('Não deu pra abrir essa foto. Tenta de novo.'));
    img.src = url;
  });
}

/** Turns the photo from the camera into a small square JPEG (center crop), as a data URL. */
export async function selfieJpeg(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Isso não é uma foto.');
  const img = await loadImage(file);
  try {
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const side = Math.min(w, h);
    const canvas = document.createElement('canvas');
    canvas.width = SIDE;
    canvas.height = SIDE;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Seu celular não deixou montar a foto.');
    // a bit above the middle on tall photos: that is where the face usually is
    const sy = h > w ? Math.max(0, (h - side) * 0.35) : (h - side) / 2;
    ctx.drawImage(img, (w - side) / 2, sy, side, side, 0, 0, SIDE, SIDE);
    for (const q of [0.82, 0.7, 0.55]) {
      const out = canvas.toDataURL('image/jpeg', q);
      if (out.length < 110_000) return out;
    }
    throw new Error('A foto ficou grande demais. Tenta de novo.');
  } finally {
    URL.revokeObjectURL(img.src);
  }
}

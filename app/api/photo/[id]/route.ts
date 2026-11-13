import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/supabase-server';
import { PHOTO_MAX_AGE_MS } from '@/lib/photos';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One person's selfie, for the projector and the phones. The address carries ?v=<photo time>, so
 * the browser may keep it; a new photo gets a new address. Not kept by the CDN, so a deleted photo
 * really goes away.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID_RE.test(id)) return new NextResponse(null, { status: 404 });
  try {
    const [{ data: photo }, { data: s }] = await Promise.all([
      db().from('singer_photos').select('jpeg, created_at').eq('singer_id', id).maybeSingle(),
      db().from('settings').select('photos_enabled').eq('id', 1).maybeSingle(),
    ]);
    const tooOld = !photo || Date.now() - new Date(photo.created_at).getTime() > PHOTO_MAX_AGE_MS;
    if (tooOld || s?.photos_enabled === false) return new NextResponse(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    return new NextResponse(Buffer.from(photo.jpeg, 'base64'), {
      headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=43200', 'X-Content-Type-Options': 'nosniff' },
    });
  } catch {
    return new NextResponse(null, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}

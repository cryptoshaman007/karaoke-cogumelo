import { ADMIN_COOKIE } from '@/lib/auth';
import { json } from '@/lib/http';

export async function POST() {
  const res = json({ ok: true });
  res.cookies.delete(ADMIN_COOKIE);
  return res;
}

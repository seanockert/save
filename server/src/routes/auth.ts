import { Hono } from 'hono';
import { setCookie, deleteCookie } from 'hono/cookie';
import { signToken, requireAuth } from '../lib/auth';
import type { AppEnv } from '../lib/env';

const auth = new Hono<{ Bindings: AppEnv }>();

const encoder = new TextEncoder();

async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

auth.post('/login', async (c) => {
  const { success } = await c.env.LOGIN_LIMITER.limit({ key: c.req.header('cf-connecting-ip') || 'unknown' });
  if (!success) return c.json({ error: 'Too many attempts' }, 429);

  const body = await c.req.json<{ password?: unknown }>().catch(() => ({}) as { password?: unknown });
  if (typeof body.password !== 'string' || !(await safeEqual(body.password, c.env.AUTH_PASSWORD))) {
    return c.json({ error: 'Invalid password' }, 401);
  }

  const token = await signToken(c.env.AUTH_SECRET);
  setCookie(c, 'save_session', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'Strict',
    maxAge: 60 * 60 * 24 * 30,
    path: '/',
  });

  return c.json({ ok: true });
});

auth.post('/logout', (c) => {
  deleteCookie(c, 'save_session', { path: '/' });
  return c.json({ ok: true });
});

auth.get('/check', requireAuth, (c) => {
  return c.json({ ok: true });
});

export default auth;

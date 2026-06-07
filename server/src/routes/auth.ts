import { Hono } from 'hono';
import { setCookie, deleteCookie } from 'hono/cookie';
import { signToken, verifyToken, requireAuth } from '../lib/auth';
import type { AppEnv } from '../lib/env';

const auth = new Hono<{ Bindings: AppEnv }>();

auth.post('/login', async (c) => {
  const body = await c.req.json<{ password?: string }>();
  if (!body.password || body.password !== c.env.AUTH_PASSWORD) {
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

auth.post('/logout', requireAuth, (c) => {
  deleteCookie(c, 'save_session', { path: '/' });
  return c.json({ ok: true });
});

auth.get('/check', requireAuth, (c) => {
  return c.json({ ok: true });
});

export default auth;

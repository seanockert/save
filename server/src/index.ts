import { Hono } from 'hono';
import authRoutes from './routes/auth';
import bookmarkRoutes from './routes/bookmarks';
import { requireAuth } from './lib/auth';
import type { AppEnv } from './lib/env';

type Env = { Bindings: AppEnv };
const app = new Hono<Env>();

app.route('/api/auth', authRoutes);
app.route('/api/bookmarks', bookmarkRoutes);

app.get('/api/tags', requireAuth, async (c) => {
  const db = c.env.DB;
  const rows = await db.prepare(
    `SELECT t.name, COUNT(bt.bookmarkId) as count
     FROM tag t
     LEFT JOIN bookmark_tag bt ON t.id = bt.tagId
     GROUP BY t.id
     HAVING count > 0
     ORDER BY count DESC, t.name ASC`
  ).all();

  return c.json(rows.results || []);
});

app.get('*', async (c) => {
  return c.env.ASSETS.fetch(new Request(new URL('/index.html', c.req.url)));
});

export default app;

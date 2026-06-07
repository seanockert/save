import { Hono } from 'hono';
import { requireAuth } from '../lib/auth';
import { sanitizeUrl, extractDomain } from '../lib/sanitize';
import { fetchOpenGraph, fallbackFromUrl } from '../lib/opengraph';
import { getAutoTags } from '../lib/tags';
import type { AppEnv } from '../lib/env';

const bookmarks = new Hono<{ Bindings: AppEnv }>();

bookmarks.use('*', requireAuth);

bookmarks.get('/', async (c) => {
  const db = c.env.DB;
  const page = Math.max(1, Number(c.req.query('page')) || 1);
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit')) || 20));
  const search = c.req.query('search') || null;
  const tag = c.req.query('tag') || null;
  const sort = c.req.query('sort') === 'oldest' ? 'ASC' : 'DESC';
  const offset = (page - 1) * limit;

  let countQuery = 'SELECT COUNT(DISTINCT b.id) as total FROM bookmark b';
  let dataQuery = `SELECT b.*, GROUP_CONCAT(t.name) as tagNames FROM bookmark b`;
  const joins = ' LEFT JOIN bookmark_tag bt ON b.id = bt.bookmarkId LEFT JOIN tag t ON bt.tagId = t.id';
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (tag) {
    conditions.push('b.id IN (SELECT bt2.bookmarkId FROM bookmark_tag bt2 JOIN tag t2 ON bt2.tagId = t2.id WHERE t2.name = ?)');
    params.push(tag);
  }

  if (search) {
    const like = `%${search}%`;
    conditions.push('(b.title LIKE ? OR b.description LIKE ? OR b.url LIKE ?)');
    params.push(like, like, like);
  }

  const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';

  countQuery += joins + where;
  dataQuery += joins + where + ` GROUP BY b.id ORDER BY b.createdAt ${sort} LIMIT ? OFFSET ?`;

  const countParams = [...params];
  params.push(limit, offset);

  const [countResult, dataResult] = await Promise.all([
    db.prepare(countQuery).bind(...countParams).first<{ total: number }>(),
    db.prepare(dataQuery).bind(...params).all(),
  ]);

  const total = countResult?.total || 0;
  const data = (dataResult.results || []).map(formatBookmarkRow);

  return c.json({
    data,
    total,
    page,
    limit,
    hasMore: offset + limit < total,
  });
});

bookmarks.get('/:id', async (c) => {
  return await getBookmarkWithTags(c.env.DB, c.req.param('id'), c);
});

bookmarks.post('/', async (c) => {
  const db = c.env.DB;
  const body = await c.req.json<{ url?: string }>();

  if (!body.url || typeof body.url !== 'string') {
    return c.json({ error: 'URL is required' }, 400);
  }

  let cleanUrl: string;
  try {
    cleanUrl = sanitizeUrl(body.url.trim());
  } catch {
    return c.json({ error: 'Invalid URL' }, 400);
  }

  const domain = extractDomain(cleanUrl);

  const existing = await db.prepare('SELECT id FROM bookmark WHERE url = ?').bind(cleanUrl).first<{ id: string }>();

  if (existing) {
    c.executionCtx.waitUntil(refreshMetadata(db, existing.id, cleanUrl));
    return await getBookmarkWithTags(db, existing.id, c);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const fallback = fallbackFromUrl(cleanUrl);
  const autoTags = getAutoTags(cleanUrl, { title: null, description: null, image: null, siteName: null });

  await db.batch([
    db.prepare(
      'INSERT INTO bookmark (id, url, title, description, image, domain, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(id, cleanUrl, fallback.title, null, null, domain, now, now),
    ...tagLinkStatements(db, id, autoTags),
  ]);

  c.executionCtx.waitUntil(refreshMetadata(db, id, cleanUrl));

  return c.json({
    id,
    url: cleanUrl,
    title: fallback.title,
    description: null,
    image: null,
    domain,
    createdAt: now,
    updatedAt: now,
    tags: autoTags,
  }, 201);
});

bookmarks.put('/:id', async (c) => {
  const db = c.env.DB;
  const id = c.req.param('id');
  const body = await c.req.json<{ title?: string; description?: string; tags?: string[] }>();

  const now = new Date().toISOString();
  const updates: string[] = ['updatedAt = ?'];
  const values: (string | null)[] = [now];

  if (body.title !== undefined) {
    updates.push('title = ?');
    values.push(body.title);
  }
  if (body.description !== undefined) {
    updates.push('description = ?');
    values.push(body.description);
  }

  const result = await db.prepare(
    `UPDATE bookmark SET ${updates.join(', ')} WHERE id = ?`
  ).bind(...values, id).run();

  if (!result.meta.changes) {
    return c.json({ error: 'Bookmark not found' }, 404);
  }

  if (body.tags !== undefined) {
    await db.batch([
      db.prepare('DELETE FROM bookmark_tag WHERE bookmarkId = ?').bind(id),
      ...tagLinkStatements(db, id, body.tags),
    ]);
  }

  return await getBookmarkWithTags(db, id, c);
});

bookmarks.delete('/:id', async (c) => {
  const db = c.env.DB;
  const id = c.req.param('id');
  const result = await db.prepare('DELETE FROM bookmark WHERE id = ?').bind(id).run();

  if (!result.meta.changes) {
    return c.json({ error: 'Bookmark not found' }, 404);
  }

  return c.json({ ok: true });
});

async function refreshMetadata(db: D1Database, id: string, url: string) {
  try {
    const ogData = await fetchOpenGraph(url);
    const now = new Date().toISOString();

    const updates: string[] = ['updatedAt = ?'];
    const values: (string | null)[] = [now];

    if (ogData.title) {
      updates.push('title = ?');
      values.push(ogData.title);
    }
    if (ogData.description) {
      updates.push('description = ?');
      values.push(ogData.description);
    }
    if (ogData.image) {
      updates.push('image = ?');
      values.push(ogData.image);
    }

    await db.batch([
      db.prepare(`UPDATE bookmark SET ${updates.join(', ')} WHERE id = ?`).bind(...values, id),
      ...tagLinkStatements(db, id, getAutoTags(url, ogData)),
    ]);
  } catch {
    // Background task — metadata will be missing but bookmark is saved
  }
}

async function getBookmarkWithTags(db: D1Database, id: string, c: any) {
  const row = await db.prepare(
    `SELECT b.*, GROUP_CONCAT(t.name) as tagNames
     FROM bookmark b
     LEFT JOIN bookmark_tag bt ON b.id = bt.bookmarkId
     LEFT JOIN tag t ON bt.tagId = t.id
     WHERE b.id = ?
     GROUP BY b.id`
  ).bind(id).first<Record<string, unknown>>();

  if (!row) return c.json({ error: 'Bookmark not found' }, 404);

  return c.json(formatBookmarkRow(row));
}

function tagLinkStatements(db: D1Database, bookmarkId: string, tagNames: string[]): D1PreparedStatement[] {
  const stmts: D1PreparedStatement[] = [];
  for (const name of tagNames) {
    const trimmed = name.trim().toLowerCase();
    if (!trimmed) continue;
    stmts.push(
      db.prepare('INSERT OR IGNORE INTO tag (id, name) VALUES (?, ?)').bind(crypto.randomUUID(), trimmed)
    );
    stmts.push(
      db.prepare(
        'INSERT OR IGNORE INTO bookmark_tag (bookmarkId, tagId) SELECT ?, id FROM tag WHERE name = ?'
      ).bind(bookmarkId, trimmed)
    );
  }
  return stmts;
}

function formatBookmarkRow(row: Record<string, unknown>) {
  return {
    ...row,
    tags: row.tagNames ? (row.tagNames as string).split(',') : [],
    tagNames: undefined,
  };
}

export default bookmarks;

import { Hono, type Context } from 'hono';
import { requireAuth } from '../lib/auth';
import { sanitizeUrl, extractDomain } from '../lib/sanitize';
import { fetchOpenGraph, fallbackFromUrl } from '../lib/opengraph';
import { generateTags, type TagInput } from '../lib/tags';
import { publish } from '../lib/sync';
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
    // Notes have a placeholder url, so it is not searchable.
    conditions.push("(b.title LIKE ? OR b.description LIKE ? OR (b.type = 'bookmark' AND b.url LIKE ?))");
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

// Change marker for cross-device polling: count covers adds/deletes,
// maxUpdatedAt covers edits. Must precede '/:id'.
bookmarks.get('/version', async (c) => {
  const row = await c.env.DB.prepare(
    'SELECT COUNT(*) as count, MAX(updatedAt) as maxUpdatedAt FROM bookmark'
  ).first<{ count: number; maxUpdatedAt: string | null }>();

  return c.json({ count: row?.count || 0, maxUpdatedAt: row?.maxUpdatedAt || null });
});

// One-off backfill: re-tag existing bookmarks in batches (the client loops
// until done) to stay under the subrequest cap. Idempotent.
bookmarks.post('/retag', async (c) => {
  const db = c.env.DB;
  const limit = Math.min(20, Math.max(1, Number(c.req.query('limit')) || 20));
  const offset = Math.max(0, Number(c.req.query('offset')) || 0);

  const totalRow = await db.prepare('SELECT COUNT(*) as total FROM bookmark').first<{ total: number }>();
  const total = totalRow?.total || 0;

  const rows = await db.prepare(
    'SELECT id, url, title, description, domain, type FROM bookmark ORDER BY createdAt ASC LIMIT ? OFFSET ?'
  ).bind(limit, offset).all<{ id: string; url: string; title: string | null; description: string | null; domain: string; type: string }>();

  const batch = rows.results || [];
  // Established categories from the DB (used by 2+ bookmarks); one-off tags are
  // deliberately excluded so they don't reinforce themselves during re-tagging.
  const dbEstablished = await getEstablishedTagNames(db);
  // Track categories assigned within this run so a category that recurs here
  // becomes reusable for later items, even before it's persisted.
  const runCounts = new Map<string, number>();

  let failed = 0;
  for (const b of batch) {
    const established = [
      ...new Set([
        ...dbEstablished,
        ...[...runCounts].filter(([, n]) => n >= 2).map(([name]) => name),
      ]),
    ];
    const tags = await generateTags(
      c.env.AI,
      { url: b.type === 'text' ? '' : b.url, domain: b.domain, title: b.title, description: b.description },
      established
    );
    // A genuine failure (null) leaves existing tags intact rather than wiping
    // them. A successful result — even an empty one — replaces them, so re-tagging
    // clears stale, low-quality tags a page no longer warrants.
    if (tags === null) {
      failed++;
      continue;
    }
    await db.batch([
      db.prepare('DELETE FROM bookmark_tag WHERE bookmarkId = ?').bind(b.id),
      ...tagLinkStatements(db, b.id, tags),
    ]);
    for (const t of tags) runCounts.set(t, (runCounts.get(t) || 0) + 1);
  }

  await cleanupOrphanTags(db);

  const nextOffset = offset + batch.length;
  const done = nextOffset >= total || batch.length === 0;

  // Re-tagging touches every bookmark, so tell clients to reload rather than
  // publishing an event per row.
  if (done) c.executionCtx.waitUntil(publish(c.env, { type: 'refresh' }));

  return c.json({ processed: batch.length, failed, total, nextOffset, done });
});

bookmarks.get('/:id', async (c) => {
  return await getBookmarkWithTags(c.env.DB, c.req.param('id'), c);
});

bookmarks.post('/', async (c) => {
  const db = c.env.DB;
  const body = await c.req.json<{ url?: string; type?: string; description?: string }>();

  if (body.type === 'text') return await createNote(c, body.description);

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
    c.executionCtx.waitUntil(refreshMetadata(c.env, existing.id, cleanUrl));
    return await getBookmarkWithTags(db, existing.id, c);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const fallback = fallbackFromUrl(cleanUrl);

  // Tags are generated in refreshMetadata once we have a title/description.
  await db.prepare(
    'INSERT INTO bookmark (id, url, title, description, image, domain, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, cleanUrl, fallback.title, null, null, domain, now, now).run();

  const created = {
    id,
    url: cleanUrl,
    title: fallback.title,
    description: null,
    image: null,
    domain,
    createdAt: now,
    updatedAt: now,
    tags: [],
  };

  c.executionCtx.waitUntil(publish(c.env, { type: 'created', bookmark: created }));
  c.executionCtx.waitUntil(refreshMetadata(c.env, id, cleanUrl));

  return c.json(created, 201);
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
    await cleanupOrphanTags(db);
  }

  const bookmark = await fetchBookmark(db, id);
  if (!bookmark) return c.json({ error: 'Bookmark not found' }, 404);

  c.executionCtx.waitUntil(publish(c.env, { type: 'updated', bookmark }));

  return c.json(bookmark);
});

bookmarks.delete('/:id', async (c) => {
  const db = c.env.DB;
  const id = c.req.param('id');
  const result = await db.prepare('DELETE FROM bookmark WHERE id = ?').bind(id).run();

  if (!result.meta.changes) {
    return c.json({ error: 'Bookmark not found' }, 404);
  }

  // links cascade-delete; clear any now-orphaned tags
  await cleanupOrphanTags(db);

  c.executionCtx.waitUntil(publish(c.env, { type: 'deleted', id }));

  return c.json({ ok: true });
});

async function refreshMetadata(env: AppEnv, id: string, url: string) {
  const db = env.DB;
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

    await db.prepare(`UPDATE bookmark SET ${updates.join(', ')} WHERE id = ?`).bind(...values, id).run();

    await tagAndPublish(env, id, {
      url,
      domain: extractDomain(url),
      title: ogData.title,
      description: ogData.description,
    });
  } catch {
    // Background task — metadata, tags and the broadcast are best-effort; the bookmark is saved.
  }
}

async function createNote(c: Context<{ Bindings: AppEnv }>, text: unknown) {
  if (typeof text !== 'string' || !text.trim()) {
    return c.json({ error: 'Text is required' }, 400);
  }

  const db = c.env.DB;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  // Placeholder url keeps the NOT NULL and UNIQUE constraints satisfied.
  const url = `note:${id}`;

  await db.prepare(
    "INSERT INTO bookmark (id, url, title, description, image, domain, type, createdAt, updatedAt) VALUES (?, ?, NULL, ?, NULL, '', 'text', ?, ?)"
  ).bind(id, url, text, now, now).run();

  const created = {
    id,
    url,
    title: null,
    description: text,
    image: null,
    domain: '',
    type: 'text',
    createdAt: now,
    updatedAt: now,
    tags: [],
  };

  c.executionCtx.waitUntil(publish(c.env, { type: 'created', bookmark: created }));
  c.executionCtx.waitUntil(
    tagAndPublish(c.env, id, { url: '', domain: '', title: null, description: text }).catch(() => {})
  );

  return c.json(created, 201);
}

// Tags the row, reusing established categories where possible, then pushes the
// finished row to every client (tags land well after the save).
async function tagAndPublish(env: AppEnv, id: string, input: TagInput) {
  const db = env.DB;
  const established = await getEstablishedTagNames(db);
  const tags = await generateTags(env.AI, input, established);

  // Only replace tags when generation produced something — a failed (null) or
  // empty result should leave any existing tags intact on a re-fetch.
  if (tags && tags.length > 0) {
    await db.batch([
      db.prepare('DELETE FROM bookmark_tag WHERE bookmarkId = ?').bind(id),
      ...tagLinkStatements(db, id, tags),
    ]);
    await cleanupOrphanTags(db);
  }

  const bookmark = await fetchBookmark(db, id);
  if (bookmark) await publish(env, { type: 'updated', bookmark });
}

async function getEstablishedTagNames(db: D1Database): Promise<string[]> {
  // Only categories used by 2+ bookmarks, most-used first. Excluding the
  // one-off long tail keeps low-quality tags from being fed back to the model
  // as examples and reinforcing themselves.
  const res = await db.prepare(
    `SELECT t.name FROM tag t
     JOIN bookmark_tag bt ON bt.tagId = t.id
     GROUP BY t.id
     HAVING COUNT(bt.bookmarkId) >= 2
     ORDER BY COUNT(bt.bookmarkId) DESC, t.name ASC`
  ).all<{ name: string }>();
  return (res.results || []).map((r) => r.name);
}

async function cleanupOrphanTags(db: D1Database): Promise<void> {
  // Remove tags no longer linked to any bookmark.
  await db.prepare('DELETE FROM tag WHERE id NOT IN (SELECT tagId FROM bookmark_tag)').run();
}

async function getBookmarkWithTags(db: D1Database, id: string, c: any) {
  const bookmark = await fetchBookmark(db, id);
  if (!bookmark) return c.json({ error: 'Bookmark not found' }, 404);
  return c.json(bookmark);
}

async function fetchBookmark(db: D1Database, id: string) {
  const row = await db.prepare(
    `SELECT b.*, GROUP_CONCAT(t.name) as tagNames
     FROM bookmark b
     LEFT JOIN bookmark_tag bt ON b.id = bt.bookmarkId
     LEFT JOIN tag t ON bt.tagId = t.id
     WHERE b.id = ?
     GROUP BY b.id`
  ).bind(id).first<Record<string, unknown>>();

  return row ? formatBookmarkRow(row) : null;
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

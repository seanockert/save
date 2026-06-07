CREATE TABLE IF NOT EXISTS "bookmark" (
  "id"          TEXT NOT NULL PRIMARY KEY,
  "url"         TEXT NOT NULL,
  "title"       TEXT,
  "description" TEXT,
  "image"       TEXT,
  "domain"      TEXT NOT NULL,
  "createdAt"   TEXT NOT NULL,
  "updatedAt"   TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "bookmark_url_idx" ON "bookmark" ("url");
CREATE INDEX IF NOT EXISTS "bookmark_domain_idx" ON "bookmark" ("domain");
CREATE INDEX IF NOT EXISTS "bookmark_createdAt_idx" ON "bookmark" ("createdAt");

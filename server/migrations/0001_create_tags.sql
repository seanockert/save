CREATE TABLE IF NOT EXISTS "tag" (
  "id"   TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS "bookmark_tag" (
  "bookmarkId" TEXT NOT NULL REFERENCES "bookmark" ("id") ON DELETE CASCADE,
  "tagId"      TEXT NOT NULL REFERENCES "tag" ("id") ON DELETE CASCADE,
  PRIMARY KEY ("bookmarkId", "tagId")
);

CREATE INDEX IF NOT EXISTS "bookmark_tag_bookmarkId_idx" ON "bookmark_tag" ("bookmarkId");
CREATE INDEX IF NOT EXISTS "bookmark_tag_tagId_idx" ON "bookmark_tag" ("tagId");

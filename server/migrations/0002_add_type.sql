-- 'bookmark' or 'text'. Text notes store url = 'note:<id>' and domain = ''
-- so the NOT NULL and UNIQUE constraints on url still hold.
ALTER TABLE "bookmark" ADD COLUMN "type" TEXT NOT NULL DEFAULT 'bookmark';

-- Notes: type = 'text', url = 'note:<id>', domain = ''
ALTER TABLE "bookmark" ADD COLUMN "type" TEXT NOT NULL DEFAULT 'bookmark';

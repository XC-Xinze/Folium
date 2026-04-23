import Database from 'better-sqlite3';

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS cards (
  luhmann_id   TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'ATOMIC' CHECK (status IN ('ATOMIC', 'INDEX')),
  parent_id    TEXT,
  sort_key     TEXT NOT NULL,
  depth        INTEGER NOT NULL,
  content_md   TEXT NOT NULL,
  file_path    TEXT NOT NULL UNIQUE,
  mtime        INTEGER NOT NULL,
  created_at   TEXT,
  updated_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_cards_sort     ON cards(sort_key);
CREATE INDEX IF NOT EXISTS idx_cards_parent   ON cards(parent_id);
CREATE INDEX IF NOT EXISTS idx_cards_status   ON cards(status);

CREATE TABLE IF NOT EXISTS tags (
  name TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS card_tags (
  luhmann_id TEXT NOT NULL REFERENCES cards(luhmann_id) ON DELETE CASCADE,
  tag        TEXT NOT NULL REFERENCES tags(name)        ON DELETE CASCADE,
  PRIMARY KEY (luhmann_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_card_tags_tag ON card_tags(tag);

-- 双链：source 卡片正文中通过 [[target]] 引用了 target
CREATE TABLE IF NOT EXISTS cross_links (
  source_id TEXT NOT NULL REFERENCES cards(luhmann_id) ON DELETE CASCADE,
  target_id TEXT NOT NULL,
  PRIMARY KEY (source_id, target_id)
);

CREATE INDEX IF NOT EXISTS idx_links_target ON cross_links(target_id);

-- FTS5 索引：用于潜在链接发现 + 全文搜索
CREATE VIRTUAL TABLE IF NOT EXISTS cards_fts USING fts5(
  luhmann_id UNINDEXED,
  title,
  content_md,
  tokenize = 'unicode61'
);

-- cards 与 fts 同步触发器
CREATE TRIGGER IF NOT EXISTS cards_ai AFTER INSERT ON cards BEGIN
  INSERT INTO cards_fts(luhmann_id, title, content_md)
  VALUES (new.luhmann_id, new.title, new.content_md);
END;

CREATE TRIGGER IF NOT EXISTS cards_ad AFTER DELETE ON cards BEGIN
  DELETE FROM cards_fts WHERE luhmann_id = old.luhmann_id;
END;

CREATE TRIGGER IF NOT EXISTS cards_au AFTER UPDATE ON cards BEGIN
  DELETE FROM cards_fts WHERE luhmann_id = old.luhmann_id;
  INSERT INTO cards_fts(luhmann_id, title, content_md)
  VALUES (new.luhmann_id, new.title, new.content_md);
END;
`;

export function initSchema(db: Database.Database): void {
  db.exec(SCHEMA_SQL);
}

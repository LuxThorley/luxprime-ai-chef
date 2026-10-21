-- Escoffier, A Guide to Modern Cookery (1907, public domain) — grounding library. Data: node scripts/escoffier-d1-sql.js
CREATE TABLE IF NOT EXISTS escoffier (id INTEGER PRIMARY KEY, no TEXT UNIQUE NOT NULL, n INTEGER NOT NULL, title TEXT NOT NULL, chapter TEXT, section TEXT, sub TEXT, text TEXT NOT NULL, ingredients TEXT, method TEXT, refs TEXT);
CREATE INDEX IF NOT EXISTS escoffier_section ON escoffier(section, n);
CREATE VIRTUAL TABLE IF NOT EXISTS escoffier_fts USING fts5(title, section, text, content='escoffier', content_rowid='id', tokenize='unicode61 remove_diacritics 2');

'use strict';
const path = require('path'); const fs = require('fs');
const Database = require('better-sqlite3');
function open(file = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'luxprime.db')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL'); db.pragma('foreign_keys = ON');
  db.exec(`
  CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, name TEXT,
    plan TEXT NOT NULL DEFAULT 'free', sub_status TEXT, stripe_customer_id TEXT, stripe_subscription_id TEXT,
    searches_used INTEGER NOT NULL DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS favourites (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    recipe_id TEXT NOT NULL, recipe_json TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id, recipe_id));
  CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    query_json TEXT NOT NULL, titles TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS shares (id TEXT PRIMARY KEY, recipe_json TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS stripe_events (id TEXT PRIMARY KEY, created_at TEXT DEFAULT CURRENT_TIMESTAMP);`);
  loadEscoffier(db);
  return db;
}
// Load the public-domain Escoffier guide into SQLite (FTS5) once.
function loadEscoffier(db, file = path.join(__dirname, '..', 'data', 'escoffier.json')) {
  const esc = require('./escoffier'); esc.SCHEMA_SQL.forEach(s => db.exec(s));
  if (db.prepare('SELECT COUNT(*) c FROM escoffier').get().c || !fs.existsSync(file)) return;
  const { entries } = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ins = db.prepare('INSERT INTO escoffier(no,n,title,chapter,section,sub,text,ingredients,method,refs) VALUES(?,?,?,?,?,?,?,?,?,?)');
  db.transaction(() => { for (const e of entries) ins.run(e.no, e.n, e.title, e.chapter, e.section, e.sub || null, e.text, e.ingredients ? JSON.stringify(e.ingredients) : null, e.method || null, e.refs ? JSON.stringify(e.refs) : null); })();
  db.exec("INSERT INTO escoffier_fts(escoffier_fts) VALUES('rebuild')");
}
module.exports = { open, loadEscoffier };

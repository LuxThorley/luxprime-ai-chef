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
  return db;
}
module.exports = { open };

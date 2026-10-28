-- Additive: per-member shopping list written by the Malcolm assistant tools (and future UI). Owner-only; removed with the account.
CREATE TABLE IF NOT EXISTS shopping_items (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item TEXT NOT NULL, qty TEXT, recipe_title TEXT, done INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS shopping_items_user ON shopping_items(user_id, id);

-- Ratings, stored recipes (stable IDs), engagement events, synced preferences. Additive only; backfills recipes from existing favourites.
CREATE TABLE IF NOT EXISTS recipes (id TEXT PRIMARY KEY, title TEXT NOT NULL, cuisine TEXT, recipe_json TEXT NOT NULL, image_key TEXT, source TEXT, created_by INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS ratings (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, recipe_id TEXT NOT NULL, stars INTEGER NOT NULL CHECK (stars BETWEEN 1 AND 5), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (user_id, recipe_id));
CREATE INDEX IF NOT EXISTS ratings_recipe ON ratings(recipe_id);
CREATE TABLE IF NOT EXISTS recipe_events (recipe_id TEXT NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL, day INTEGER NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (recipe_id, actor, kind, day));
CREATE INDEX IF NOT EXISTS events_recipe ON recipe_events(recipe_id);
CREATE TABLE IF NOT EXISTS user_prefs (user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, prefs_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS favourites_recipe ON favourites(recipe_id);
INSERT OR IGNORE INTO recipes(id,title,cuisine,recipe_json,created_by) SELECT recipe_id, COALESCE(json_extract(recipe_json,'$.title'),'Recipe'), json_extract(recipe_json,'$.cuisine'), recipe_json, user_id FROM favourites;

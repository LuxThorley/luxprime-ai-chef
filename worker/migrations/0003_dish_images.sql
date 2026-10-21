-- AI dish photos: prompt registry (server-built prompts only) + per-user daily generation caps. Images live in KV (IMAGES).
CREATE TABLE IF NOT EXISTS dish_images (key TEXT PRIMARY KEY, title TEXT, prompt TEXT NOT NULL, alt TEXT, status TEXT NOT NULL DEFAULT 'pending', provider TEXT, ms INTEGER, error TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT);
CREATE TABLE IF NOT EXISTS image_usage (user_id INTEGER NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, day));

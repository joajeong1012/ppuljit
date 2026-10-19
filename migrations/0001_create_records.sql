CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  nickname TEXT NOT NULL CHECK (length(nickname) BETWEEN 1 AND 20),
  seed TEXT NOT NULL CHECK (length(seed) BETWEEN 1 AND 64),
  slots INTEGER NOT NULL CHECK (slots BETWEEN 3 AND 10),
  attributes INTEGER NOT NULL CHECK (attributes BETWEEN 1 AND 3),
  question_count INTEGER NOT NULL CHECK (question_count >= 0),
  elapsed_ms INTEGER NOT NULL CHECK (elapsed_ms >= 0),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS records_leaderboard
ON records (slots, attributes, question_count, elapsed_ms, created_at);

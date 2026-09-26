CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY,
  user_sub TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS attention_events (
  time TIMESTAMPTZ NOT NULL,
  session_id UUID NOT NULL,
  user_sub TEXT NOT NULL,
  state TEXT NOT NULL,
  score DOUBLE PRECISION,
  is_transition BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS questions (
  time TIMESTAMPTZ NOT NULL,
  session_id UUID NOT NULL,
  user_sub TEXT NOT NULL,
  mode TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS attention_events_user_time_idx
  ON attention_events (user_sub, time DESC);

CREATE INDEX IF NOT EXISTS questions_user_time_idx
  ON questions (user_sub, time DESC);

import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const storePath = path.join(process.cwd(), "data", "store.json");
let pool;
let ready;

function emptyStore() {
  return { sessions: [], attention_events: [], questions: [] };
}

function readStore() {
  if (!fs.existsSync(storePath)) return emptyStore();
  return JSON.parse(fs.readFileSync(storePath, "utf8"));
}

function writeStore(store) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
}

function getPool() {
  if (!process.env.DATABASE_URL) return null;
  if (!pool) pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  return pool;
}

export function storageKind() {
  return process.env.DATABASE_URL ? "tiger" : "file";
}

function parseTime(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return new Date();
  const delta = date.getTime() - Date.now();
  if (delta > 5 * 60 * 1000 || delta < -2 * 24 * 60 * 60 * 1000) return new Date();
  return date;
}

export async function initDb() {
  if (ready) return;
  const db = getPool();
  if (!db) {
    if (!fs.existsSync(storePath)) writeStore(emptyStore());
    ready = true;
    return;
  }
  const schema = fs.readFileSync(path.join(process.cwd(), "db", "schema.sql"), "utf8");
  const statements = schema
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  for (const statement of statements) {
    await db.query(statement);
  }
  try {
    await db.query("CREATE EXTENSION IF NOT EXISTS timescaledb");
    await db.query("SELECT create_hypertable('attention_events', 'time', if_not_exists => TRUE)");
  } catch (error) {
    console.warn("Timescale hypertable was not created:", error.message);
  }
  ready = true;
}

async function assertSession(userSub, sessionId) {
  await initDb();
  const db = getPool();
  if (!db) {
    const store = readStore();
    const session = store.sessions.find((item) => item.id === sessionId && item.user_sub === userSub);
    if (!session) throw new Error("Session not found.");
    return;
  }
  const result = await db.query("SELECT id FROM sessions WHERE id = $1 AND user_sub = $2", [sessionId, userSub]);
  if (!result.rowCount) throw new Error("Session not found.");
}

export async function startSession(userSub, startedAt) {
  await initDb();
  const id = crypto.randomUUID();
  const time = parseTime(startedAt);
  const db = getPool();
  if (!db) {
    const store = readStore();
    store.sessions.push({ id, user_sub: userSub, started_at: time.toISOString(), ended_at: null });
    writeStore(store);
    return id;
  }
  await db.query("INSERT INTO sessions (id, user_sub, started_at) VALUES ($1, $2, $3)", [id, userSub, time]);
  return id;
}

export async function endSession(userSub, sessionId, endedAt) {
  await assertSession(userSub, sessionId);
  const time = parseTime(endedAt);
  const db = getPool();
  if (!db) {
    const store = readStore();
    const session = store.sessions.find((item) => item.id === sessionId);
    session.ended_at = time.toISOString();
    writeStore(store);
    return;
  }
  await db.query("UPDATE sessions SET ended_at = $3 WHERE id = $1 AND user_sub = $2", [sessionId, userSub, time]);
}

export async function logAttention({ userSub, sessionId, state, score, time, isTransition }) {
  if (state !== "focused" && state !== "distracted") throw new Error("Unknown attention state.");
  await assertSession(userSub, sessionId);
  const at = parseTime(time);
  const db = getPool();
  if (!db) {
    const store = readStore();
    store.attention_events.push({
      time: at.toISOString(),
      session_id: sessionId,
      user_sub: userSub,
      state,
      score: score ?? null,
      is_transition: Boolean(isTransition),
    });
    writeStore(store);
    return;
  }
  await db.query(
    `INSERT INTO attention_events (time, session_id, user_sub, state, score, is_transition)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [at, sessionId, userSub, state, score ?? null, Boolean(isTransition)],
  );
}

export async function logQuestion({ userSub, sessionId, mode, time }) {
  if (mode !== "calm" && mode !== "strict" && mode !== "nice") throw new Error("Unknown tutor mode.");
  await assertSession(userSub, sessionId);
  const at = parseTime(time);
  const db = getPool();
  if (!db) {
    const store = readStore();
    store.questions.push({
      time: at.toISOString(),
      session_id: sessionId,
      user_sub: userSub,
      mode,
    });
    writeStore(store);
    return;
  }
  await db.query(
    "INSERT INTO questions (time, session_id, user_sub, mode) VALUES ($1, $2, $3, $4)",
    [at, sessionId, userSub, mode],
  );
}

function buildDashboard(sessions, events, questions) {
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const recentEvents = events.filter((event) => new Date(event.time).getTime() >= dayAgo);
  const buckets = new Map();
  for (const event of recentEvents) {
    const bucket = new Date(event.time);
    bucket.setSeconds(0, 0);
    const key = bucket.toISOString();
    const current = buckets.get(key) || { focused: 0, total: 0 };
    current.total += 1;
    if (event.state === "focused") current.focused += 1;
    buckets.set(key, current);
  }
  const focusSeries = [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([time, value]) => ({
      time,
      focus: Math.round((value.focused / value.total) * 100),
    }));
  const focusPct = recentEvents.length
    ? Math.round((recentEvents.filter((event) => event.state === "focused").length / recentEvents.length) * 100)
    : 0;
  const distractionCount = events.filter((event) => event.state === "distracted" && event.is_transition).length;
  const questionCount = questions.length;
  const sessionRows = [...sessions]
    .sort((a, b) => new Date(b.started_at) - new Date(a.started_at))
    .slice(0, 20)
    .map((session) => {
      const sessionEvents = events.filter((event) => event.session_id === session.id);
      const focused = sessionEvents.filter((event) => event.state === "focused").length;
      return {
        id: session.id,
        startedAt: session.started_at,
        endedAt: session.ended_at,
        focusPct: sessionEvents.length ? Math.round((focused / sessionEvents.length) * 100) : 0,
        distractions: sessionEvents.filter((event) => event.state === "distracted" && event.is_transition).length,
        questions: questions.filter((question) => question.session_id === session.id).length,
      };
    });
  return { focusSeries, focusPct, distractionCount, questionCount, sessions: sessionRows, storage: "file" };
}

async function querySeries(db, userSub) {
  const select = (bucket) =>
    `SELECT ${bucket} AS bucket,
            AVG(CASE WHEN state = 'focused' THEN 1.0 ELSE 0.0 END)::float8 AS focus_ratio
     FROM attention_events
     WHERE user_sub = $1 AND time > NOW() - INTERVAL '1 day'
     GROUP BY 1
     ORDER BY 1`;
  try {
    return await db.query(select("time_bucket('1 minute', time)"), [userSub]);
  } catch {
    return db.query(select("date_trunc('minute', time)"), [userSub]);
  }
}

export async function getDashboard(userSub) {
  await initDb();
  const db = getPool();
  if (!db) {
    const store = readStore();
    return buildDashboard(
      store.sessions.filter((session) => session.user_sub === userSub),
      store.attention_events.filter((event) => event.user_sub === userSub),
      store.questions.filter((question) => question.user_sub === userSub),
    );
  }

  const [series, totals, distractions, questionTotals, sessions, sessionStats, sessionQuestions] = await Promise.all([
    querySeries(db, userSub),
    db.query(
      `SELECT AVG(CASE WHEN state = 'focused' THEN 1.0 ELSE 0.0 END)::float8 AS focus_ratio,
              COUNT(*)::int AS samples
       FROM attention_events
       WHERE user_sub = $1 AND time > NOW() - INTERVAL '1 day'`,
      [userSub],
    ),
    db.query(
      `SELECT COUNT(*)::int AS n
       FROM attention_events
       WHERE user_sub = $1 AND state = 'distracted' AND is_transition = TRUE`,
      [userSub],
    ),
    db.query("SELECT COUNT(*)::int AS n FROM questions WHERE user_sub = $1", [userSub]),
    db.query(
      `SELECT id, started_at, ended_at
       FROM sessions
       WHERE user_sub = $1
       ORDER BY started_at DESC
       LIMIT 20`,
      [userSub],
    ),
    db.query(
      `SELECT session_id,
              AVG(CASE WHEN state = 'focused' THEN 1.0 ELSE 0.0 END)::float8 AS focus_ratio,
              COUNT(*) FILTER (WHERE state = 'distracted' AND is_transition)::int AS distractions
       FROM attention_events
       WHERE user_sub = $1
       GROUP BY session_id`,
      [userSub],
    ),
    db.query(
      `SELECT session_id, COUNT(*)::int AS questions
       FROM questions
       WHERE user_sub = $1
       GROUP BY session_id`,
      [userSub],
    ),
  ]);

  const statsBySession = new Map(sessionStats.rows.map((row) => [row.session_id, row]));
  const questionsBySession = new Map(sessionQuestions.rows.map((row) => [row.session_id, row.questions]));
  const focusRatio = totals.rows[0]?.focus_ratio;
  return {
    focusSeries: series.rows.map((row) => ({
      time: new Date(row.bucket).toISOString(),
      focus: Math.round(Number(row.focus_ratio) * 100),
    })),
    focusPct: totals.rows[0]?.samples ? Math.round(Number(focusRatio) * 100) : 0,
    distractionCount: distractions.rows[0]?.n || 0,
    questionCount: questionTotals.rows[0]?.n || 0,
    sessions: sessions.rows.map((session) => {
      const stats = statsBySession.get(session.id);
      return {
        id: session.id,
        startedAt: new Date(session.started_at).toISOString(),
        endedAt: session.ended_at ? new Date(session.ended_at).toISOString() : null,
        focusPct: stats ? Math.round(Number(stats.focus_ratio) * 100) : 0,
        distractions: stats?.distractions || 0,
        questions: questionsBySession.get(session.id) || 0,
      };
    }),
    storage: "tiger",
  };
}

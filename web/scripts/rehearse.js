import { endSession, getDashboard, logAttention, logQuestion, startSession } from "../lib/db.js";

const user = "dev|local";
const existing = await getDashboard(user);
if (existing.sessions.length) {
  console.log(`Dashboard already has ${existing.sessions.length} session(s).`);
  process.exit(0);
}

const end = Date.now() - 2 * 60 * 1000;
const start = end - 25 * 60 * 1000;
const sessionId = await startSession(user, new Date(start).toISOString());
let previous = "focused";

for (let time = start; time <= end; time += 30 * 1000) {
  const elapsed = time - start;
  const distracted = elapsed >= 8 * 60 * 1000 && elapsed < 12 * 60 * 1000;
  const state = distracted ? "distracted" : "focused";
  await logAttention({
    userSub: user,
    sessionId,
    state,
    score: state === "focused" ? 0.93 : 0.14,
    time: new Date(time).toISOString(),
    isTransition: state !== previous,
  });
  previous = state;
}

await logQuestion({ userSub: user, sessionId, mode: "calm", time: new Date(start + 3 * 60 * 1000).toISOString() });
await logQuestion({ userSub: user, sessionId, mode: "strict", time: new Date(start + 10 * 60 * 1000).toISOString() });
await logQuestion({ userSub: user, sessionId, mode: "calm", time: new Date(start + 18 * 60 * 1000).toISOString() });
await endSession(user, sessionId, new Date(end).toISOString());

const dashboard = await getDashboard(user);
console.log(JSON.stringify({
  sessions: dashboard.sessions.length,
  points: dashboard.focusSeries.length,
  focusPct: dashboard.focusPct,
  distractions: dashboard.distractionCount,
  questions: dashboard.questionCount,
}, null, 2));

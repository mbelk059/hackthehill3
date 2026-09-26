import { json, preflight, requireUser } from "../../../lib/api.js";
import { logAttention, logQuestion } from "../../../lib/db.js";

export const runtime = "nodejs";

export function OPTIONS() {
  return preflight();
}

export async function POST(request) {
  const { user, error } = await requireUser(request);
  if (error) return error;
  const body = await request.json().catch(() => ({}));
  if (!body.sessionId) return json({ error: "sessionId is required." }, 400);
  try {
    if (body.kind === "attention") {
      await logAttention({
        userSub: user.sub,
        sessionId: body.sessionId,
        state: body.state,
        score: body.score,
        time: body.time,
        isTransition: body.isTransition,
      });
    } else if (body.kind === "question") {
      await logQuestion({
        userSub: user.sub,
        sessionId: body.sessionId,
        mode: body.mode,
        time: body.time,
      });
    } else {
      return json({ error: "Unknown event kind." }, 400);
    }
  } catch (cause) {
    return json({ error: cause.message }, 400);
  }
  return json({ ok: true });
}

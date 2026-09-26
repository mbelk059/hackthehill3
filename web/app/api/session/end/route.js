import { json, preflight, requireUser } from "../../../../lib/api.js";
import { endSession } from "../../../../lib/db.js";

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
    await endSession(user.sub, body.sessionId, body.time);
  } catch (cause) {
    return json({ error: cause.message }, 404);
  }
  return json({ ok: true });
}

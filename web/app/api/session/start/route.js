import { json, preflight, requireUser } from "../../../../lib/api.js";
import { startSession } from "../../../../lib/db.js";

export const runtime = "nodejs";

export function OPTIONS() {
  return preflight();
}

export async function POST(request) {
  const { user, error } = await requireUser(request);
  if (error) return error;
  const body = await request.json().catch(() => ({}));
  const sessionId = await startSession(user.sub, body.time);
  return json({ sessionId });
}

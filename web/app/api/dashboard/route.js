import { json, preflight, requireUser } from "../../../lib/api.js";
import { getDashboard } from "../../../lib/db.js";

export const runtime = "nodejs";

export function OPTIONS() {
  return preflight();
}

export async function GET(request) {
  const { user, error } = await requireUser(request);
  if (error) return error;
  const data = await getDashboard(user.sub);
  return json(data);
}

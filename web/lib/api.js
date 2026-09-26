import { NextResponse } from "next/server";
import { corsHeaders } from "./cors.js";
import { getRequestUser } from "./user.js";

export function preflight() {
  return new NextResponse(null, { status: 204, headers: corsHeaders() });
}

export function json(data, status = 200) {
  return NextResponse.json(data, { status, headers: corsHeaders() });
}

export async function requireUser(request) {
  const user = await getRequestUser(request);
  if (!user) return { user: null, error: json({ error: "Unauthorized" }, 401) };
  return { user, error: null };
}

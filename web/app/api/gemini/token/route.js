import { json, preflight, requireUser } from "../../../../lib/api.js";
import { GoogleGenAI } from "@google/genai";

export const runtime = "nodejs";

export function OPTIONS() {
  return preflight();
}

export async function POST(request) {
  const { user, error } = await requireUser(request);
  if (error) return error;
  if (!process.env.GEMINI_API_KEY) {
    return json({ error: "Set GEMINI_API_KEY in web/.env.local" }, 503);
  }

  const model = process.env.GEMINI_LIVE_MODEL || "gemini-live-2.5-flash-preview";
  try {
    const ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: { apiVersion: "v1alpha" },
    });
    const expireTime = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    const created = await ai.authTokens.create({
      config: {
        uses: 20,
        expireTime,
        newSessionExpireTime: expireTime,
      },
    });
    const token = created?.name || created?.token;
    if (!token) return json({ error: "Gemini did not return a token." }, 502);
    return json({ token, model, user: user.sub });
  } catch (cause) {
    return json({ error: cause.message || "Could not mint a Gemini token." }, 502);
  }
}

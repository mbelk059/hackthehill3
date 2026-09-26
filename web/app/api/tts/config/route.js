import { json, preflight, requireUser } from "../../../../lib/api.js";

export const runtime = "nodejs";

export function OPTIONS() {
  return preflight();
}

export async function POST(request) {
  const { error } = await requireUser(request);
  if (error) return error;
  const alice = "Xb7hH8MSUJpSbSDYk0k2";
  const calm = process.env.ELEVENLABS_VOICE_CALM || alice;
  const strict = process.env.ELEVENLABS_VOICE_STRICT || "onwK4e9ZLuTAKqWW03F9";
  const paidCalm = new Set([
    "0h0djH5IqUoVaa1Pnuq7",
    "21m00Tcm4TlvDq8ikWAM",
    "EXAVITQu4vr4xnSDxMaL",
  ]);
  return json({
    apiKey: process.env.ELEVENLABS_API_KEY || "",
    voiceCalm: paidCalm.has(calm) ? alice : calm,
    voiceStrict: strict === "pNInz6obpgDQGcFmaJgB" ? "onwK4e9ZLuTAKqWW03F9" : strict,
    modelId: "eleven_flash_v2_5",
  });
}

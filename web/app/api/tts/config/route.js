import { json, preflight, requireUser } from "../../../../lib/api.js";

export const runtime = "nodejs";

export function OPTIONS() {
  return preflight();
}

export async function POST(request) {
  const { error } = await requireUser(request);
  if (error) return error;
  return json({
    apiKey: process.env.ELEVENLABS_API_KEY || "",
    voiceCalm: process.env.ELEVENLABS_VOICE_CALM || "21m00Tcm4TlvDq8ikWAM",
    voiceStrict: process.env.ELEVENLABS_VOICE_STRICT || "pNInz6obpgDQGcFmaJgB",
    modelId: "eleven_flash_v2_5",
  });
}

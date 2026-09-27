import { json, preflight, requireUser } from "../../../../lib/api.js";

export const runtime = "nodejs";

export function OPTIONS() {
  return preflight();
}

export async function POST(request) {
  const { error } = await requireUser(request);
  if (error) return error;
  const jessica = "cgSgspJ2msm6clMCkdW9";
  const calm = process.env.ELEVENLABS_VOICE_CALM || jessica;
  const paidCalm = new Set([
    "0h0djH5IqUoVaa1Pnuq7",
    "21m00Tcm4TlvDq8ikWAM",
    "EXAVITQu4vr4xnSDxMaL",
  ]);
  return json({
    apiKey: process.env.ELEVENLABS_API_KEY || "",
    voiceCalm: paidCalm.has(calm) ? jessica : calm,
    voiceStrict: calm,
    modelId: "eleven_flash_v2_5",
  });
}

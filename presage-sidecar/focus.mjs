// Presage validation codes from @smartspectra/node-sdk ValidationCode.
const FOCUSED = new Set([0, 13, 14]);
const DISTRACTED = new Set([1, 2, 3, 12, 15, 16, 17]);

const CODE_NAMES = {
  0: "kOk",
  1: "kNoFaceFound",
  2: "kMultipleFacesFound",
  3: "kFaceNotCentered",
  12: "kExcessiveMotion",
  13: "kFaceTooClose",
  14: "kFaceTooFar",
  15: "kFaceTooHigh",
  16: "kFaceTooLow",
  17: "kFaceNotForward",
};

export function interpretValidation(code) {
  const name = CODE_NAMES[code] || `code_${code}`;
  if (FOCUSED.has(code)) {
    return { score: code === 0 ? 1 : 0.72, state: "focused", code: name, label: code === 0 ? "Watching you" : "Face in frame" };
  }
  if (DISTRACTED.has(code)) {
    const labels = {
      kNoFaceFound: "No face in the camera",
      kMultipleFacesFound: "More than one face",
      kFaceNotCentered: "Move into the camera",
      kExcessiveMotion: "Hold still a moment",
      kFaceTooHigh: "Move down a little",
      kFaceTooLow: "Move up a little",
      kFaceNotForward: "Looking away",
    };
    return { score: 0.12, state: "distracted", code: name, label: labels[name] || "Looking away" };
  }
  return { score: null, state: null, code: name, label: "" };
}

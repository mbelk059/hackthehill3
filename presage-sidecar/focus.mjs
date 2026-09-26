// Presage validation codes from @smartspectra/node-sdk ValidationCode.
// A face that is still in frame counts as focused, even if it is a little
// off-center. Only leaving the camera counts as looking away.
const FOCUSED = new Set([0, 2, 3, 4, 5, 6, 12, 13, 14, 15, 16, 17]);
const DISTRACTED = new Set([1]);

const CODE_NAMES = {
  0: "kOk",
  1: "kNoFaceFound",
  2: "kMultipleFacesFound",
  3: "kFaceNotCentered",
  4: "kFaceSizeOutOfRange",
  5: "kTooDark",
  6: "kTooBright",
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
    return { score: code === 0 ? 1 : 0.8, state: "focused", code: name, label: "Watching you" };
  }
  if (DISTRACTED.has(code)) {
    return { score: 0.12, state: "distracted", code: name, label: "Looking away" };
  }
  return { score: null, state: null, code: name, label: "" };
}

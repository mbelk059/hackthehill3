export function createMoodDebouncer({ toStrictMs = 8000, toCalmMs = 5000 } = {}) {
  let mood = "calm";
  let pending = null;
  let since = 0;

  return {
    get mood() {
      return mood;
    },
    reset() {
      mood = "calm";
      pending = null;
      since = 0;
    },
    push(state, now) {
      const desired = state === "distracted" ? "strict" : "calm";
      if (desired === mood) {
        pending = null;
        return { mood, changed: false };
      }
      if (pending !== desired) {
        pending = desired;
        since = now;
        return { mood, changed: false };
      }
      const wait = desired === "strict" ? toStrictMs : toCalmMs;
      if (now - since >= wait) {
        mood = desired;
        pending = null;
        return { mood, changed: true };
      }
      return { mood, changed: false };
    },
  };
}

export function takeSentences(buffer, chunk, flush) {
  const text = buffer + (chunk || "");
  const sentences = [];
  const pattern = /[.!?]+(?:\s+|$)/g;
  let last = 0;
  let match = pattern.exec(text);
  while (match) {
    const sentence = text.slice(last, match.index + match[0].length).trim();
    if (sentence) sentences.push(sentence);
    last = match.index + match[0].length;
    match = pattern.exec(text);
  }
  let rest = text.slice(last);
  if (flush && rest.trim()) {
    sentences.push(rest.trim());
    rest = "";
  }
  return { buffer: rest, sentences };
}

export function downsample(float32, inRate, outRate) {
  if (inRate === outRate) return float32;
  const ratio = inRate / outRate;
  const length = Math.floor(float32.length / ratio);
  const result = new Float32Array(length);
  for (let i = 0; i < length; i += 1) {
    const start = Math.floor(i * ratio);
    const end = Math.max(start + 1, Math.floor((i + 1) * ratio));
    let sum = 0;
    let count = 0;
    for (let j = start; j < end && j < float32.length; j += 1) {
      sum += float32[j];
      count += 1;
    }
    result[i] = count ? sum / count : 0;
  }
  return result;
}

export function floatToPcm16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, float32[i]));
    out[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return out;
}

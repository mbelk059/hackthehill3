import { config } from "../config.js";
import { PROMPTS } from "../lib/prompts.mjs";
import {
  createMoodDebouncer,
  downsample,
  floatToPcm16,
  takeSentences,
} from "../lib/session-logic.mjs";

const SCREEN_INTERVAL_MS = 1000;
const WEBCAM_INTERVAL_MS = 125;
const ATTENTION_SAMPLE_MS = 10000;
const GEMINI_MODEL_FALLBACK = "gemini-3.8-live";

const session = {
  running: false,
  streamId: "",
  tabId: null,
  sessionId: "",
  mood: "calm",
  moodDirty: false,
  voiceDirty: false,
  ptt: false,
  epoch: 0,
  acceptEpoch: null,
  turnOpen: false,
  textBuffer: "",
  caption: "",
  speakEpoch: 0,
  dropModel: false,
  presageReady: false,
  lastFocusState: "",
  lastScore: null,
  gemini: null,
  geminiReady: false,
  tts: null,
  ttsOpen: false,
  ttsConfig: null,
  geminiModel: GEMINI_MODEL_FALLBACK,
  token: "",
  audioCtx: null,
  analyser: null,
  micSource: null,
  worklet: null,
  pcmQueue: [],
  pcmQueued: 0,
  screenTimer: 0,
  webcamTimer: 0,
  sampleTimer: 0,
  amplitudeTimer: 0,
  presageTimer: 0,
  screenVideo: null,
  webcamVideo: null,
  screenStream: null,
  micStream: null,
  webcamStream: null,
  presageWs: null,
  nextTime: 0,
  sources: [],
  debouncer: createMoodDebouncer({ toStrictMs: 1500, toCalmMs: 2000 }),
  voiceHold: null,
  userHeard: "",
  stressed: false,
};

function postPresage(detail, ready = true) {
  session.presageReady = ready;
  session.presageDetail = detail;
  chrome.runtime.sendMessage({
    type: "STATUS",
    presage: { ready, detail },
  }).catch(() => {});
}

function postStatus(error) {
  chrome.runtime.sendMessage({
    type: "STATUS",
    error: error || "",
    presage: {
      ready: session.presageReady,
      detail: session.presageDetail || (session.presageReady ? "Presage connected" : "Presage offline — mood preview still works"),
    },
  }).catch(() => {});
}

async function authHeaders() {
  const result = await chrome.runtime.sendMessage({ type: "GET_TOKEN" });
  if (!result?.token) throw new Error("Log in first.");
  return {
    Authorization: `Bearer ${result.token}`,
    "Content-Type": "application/json",
  };
}

async function api(path, body) {
  const headers = await authHeaders();
  const response = await fetch(`${config.apiBase}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function pcm16ToBase64(int16) {
  return bytesToBase64(new Uint8Array(int16.buffer));
}

function attachVideo(stream) {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  video.style.display = "none";
  document.body.append(video);
  return video.play().then(() => video);
}

function grabJpeg(video, width, height, quality) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  context.drawImage(video, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", quality).split(",")[1];
}

function sendGemini(payload) {
  if (!session.gemini || session.gemini.readyState !== WebSocket.OPEN || !session.geminiReady) return;
  session.gemini.send(JSON.stringify(payload));
}

function geminiUrl(token) {
  return `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained?access_token=${token}`;
}

function openGemini(mood) {
  return new Promise((resolve, reject) => {
    if (!session.token) {
      reject(new Error("Gemini token missing."));
      return;
    }
    const socket = new WebSocket(geminiUrl(session.token));
    let settled = false;
    const fail = (error) => {
      if (settled) {
        postStatus(error.message);
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(error);
    };
    const timeout = setTimeout(() => {
      socket.close();
      fail(new Error("Gemini setup timed out."));
    }, 10000);

    socket.onmessage = async (event) => {
      let raw = event.data;
      if (raw instanceof Blob) raw = await raw.text();
      let message;
      try {
        message = JSON.parse(raw);
      } catch {
        return;
      }
      if (message.error) {
        fail(new Error(message.error.message || "Gemini error"));
        return;
      }
      if (message.setupComplete) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        session.gemini = socket;
        session.geminiReady = true;
        resolve(socket);
        return;
      }
      if (session.gemini !== socket) return;
      handleGeminiContent(message);
    };
    socket.onerror = () => {
      fail(new Error("Gemini socket failed."));
    };
    socket.onclose = (event) => {
      if (session.gemini === socket) session.geminiReady = false;
      if (!settled) {
        const reason = event.reason || `Gemini closed (${event.code}).`;
        fail(new Error(reason));
      }
    };
    socket.onopen = () => {
      socket.send(JSON.stringify({
        setup: {
          model: `models/${session.geminiModel}`,
          generationConfig: { responseModalities: ["AUDIO"] },
          outputAudioTranscription: {},
          inputAudioTranscription: {},
          systemInstruction: { parts: [{ text: PROMPTS[mood] || PROMPTS.calm }] },
          realtimeInputConfig: {
            automaticActivityDetection: {
              disabled: false,
              prefixPaddingMs: 300,
              silenceDurationMs: 700,
            },
          },
        },
      }));
    };
  });
}

function handleGeminiContent(message) {
  const server = message.serverContent;
  if (!server) return;
  const heard = server.inputTranscription?.text || "";
  if (heard) noteUserSpeech(heard);
  if (session.dropModel) {
    if (server.interrupted || server.turnComplete) {
      session.dropModel = false;
      session.turnOpen = false;
      session.textBuffer = "";
      clearTimeout(session.flushTimer);
    }
    return;
  }
  if (session.acceptEpoch !== session.epoch) return;
  const spoken = server.outputTranscription?.text
    || (server.modelTurn?.parts || []).map((part) => part.text || "").join("");
  if (spoken) {
    if (!session.turnOpen) {
      session.turnOpen = true;
      session.caption = "";
      session.textBuffer = "";
      logQuestion();
    }
    session.caption += spoken;
    if (session.caption === spoken) {
      shownCaption = "";
      chrome.runtime.sendMessage({ type: "CAPTION", text: "" });
    }
    const split = takeSentences(session.textBuffer, spoken, false);
    session.textBuffer = split.buffer;
    for (const sentence of split.sentences) speak(sentence);
  }
  if (server.turnComplete) {
    const epoch = session.acceptEpoch;
    clearTimeout(session.flushTimer);
    session.flushTimer = setTimeout(() => {
      if (session.acceptEpoch !== epoch) return;
      const split = takeSentences(session.textBuffer, "", true);
      session.textBuffer = split.buffer;
      for (const sentence of split.sentences) speak(sentence);
      session.turnOpen = false;
      session.userHeard = "";
      if (session.moodDirty) {
        session.moodDirty = false;
        reconnectGemini();
      }
    }, 200);
  }
}

async function reconnectGemini() {
  const previous = session.gemini;
  session.gemini = null;
  session.geminiReady = false;
  try {
    await openGemini(session.mood);
    previous?.close();
  } catch (error) {
    session.gemini = previous;
    session.geminiReady = previous?.readyState === WebSocket.OPEN;
    postStatus(error.message);
  }
}

let speakQueue = Promise.resolve();
let shownCaption = "";

function showSpoken(sentence) {
  const piece = sentence.trim();
  if (!piece) return;
  shownCaption = shownCaption ? `${shownCaption} ${piece}` : piece;
  chrome.runtime.sendMessage({ type: "CAPTION", text: shownCaption });
}

function speak(sentence) {
  const text = sentence.trim();
  if (!text || !session.running) return;
  const epoch = session.speakEpoch;
  speakQueue = speakQueue.then(() => {
    if (epoch !== session.speakEpoch || !session.running) return undefined;
    return speakNow(text, epoch);
  }).catch((error) => postStatus(error.message));
}

async function speakNow(sentence, epoch) {
  const configTts = session.ttsConfig;
  if (!configTts?.apiKey) {
    postStatus("Set ELEVENLABS_API_KEY in web/.env.local so the mascot can talk.");
    return;
  }
  const voiceId = configTts.voiceCalm;
  const pace = session.mood === "strict"
    ? { stability: 1, similarity_boost: 0.55, speed: 1.2 }
    : session.mood === "nice"
      ? { stability: 0.32, similarity_boost: 0.8, speed: 0.92 }
      : { stability: 0.38, similarity_boost: 0.8, speed: 0.96 };
  const response = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=pcm_24000&optimize_streaming_latency=3`,
    {
      method: "POST",
      headers: {
        "xi-api-key": configTts.apiKey,
        "Content-Type": "application/json",
        Accept: "audio/pcm",
      },
      body: JSON.stringify({
        text: sentence,
        model_id: configTts.modelId || "eleven_flash_v2_5",
        voice_settings: {
          stability: pace.stability,
          similarity_boost: pace.similarity_boost,
          speed: pace.speed,
        },
      }),
    },
  );
  if (!response.ok) {
    const detail = await response.text();
    postStatus(detail.slice(0, 180) || "ElevenLabs could not speak.");
    return;
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!session.running || epoch !== session.speakEpoch || !bytes.byteLength) return;
    showSpoken(sentence);
    playPcm(bytesToBase64(bytes));
    return;
  }
  let pending = new Uint8Array(0);
  let started = false;
  while (true) {
    const { done, value } = await reader.read();
    if (!session.running || epoch !== session.speakEpoch) {
      try { await reader.cancel(); } catch { /* already closed */ }
      return;
    }
    if (value?.byteLength) {
      const merged = new Uint8Array(pending.length + value.length);
      merged.set(pending, 0);
      merged.set(value, pending.length);
      const even = merged.length - (merged.length % 2);
      if (even > 0) {
        pending = merged.subarray(even);
        if (!started) {
          started = true;
          showSpoken(sentence);
        }
        playPcm(bytesToBase64(merged.subarray(0, even)));
      } else {
        pending = merged;
      }
    }
    if (done) break;
  }
}

function ttsUrl(voiceId, modelId) {
  const params = new URLSearchParams({
    model_id: modelId || "eleven_flash_v2_5",
    output_format: "pcm_24000",
    inactivity_timeout: "180",
  });
  return `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?${params}`;
}

function openTts(mood) {
  const configTts = session.ttsConfig;
  if (!configTts?.apiKey) return Promise.resolve();
  if (session.tts) {
    try { session.tts.close(); } catch { /* already closed */ }
  }
  const voiceId = configTts.voiceCalm;
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(() => {
      postStatus("ElevenLabs did not connect.");
      finish();
    }, 8000);
    const socket = new WebSocket(ttsUrl(voiceId, configTts.modelId));
    session.tts = socket;
    socket.onopen = () => {
      session.ttsOpen = true;
      socket.send(JSON.stringify({
        text: " ",
        xi_api_key: configTts.apiKey,
        voice_settings: {
          stability: mood === "strict" ? 0.3 : 0.55,
          similarity_boost: 0.8,
        },
      }));
      finish();
    };
    socket.onmessage = (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.audio) playPcm(message.audio);
      if (message.error || message.message) {
        const text = String(message.error || message.message);
        if (text.includes("input_timeout")) {
          session.ttsOpen = false;
          try { socket.close(); } catch { /* already closing */ }
          return;
        }
        if (message.error) postStatus(text);
      }
    };
    socket.onerror = () => {
      postStatus("ElevenLabs socket failed.");
      finish();
    };
    socket.onclose = () => {
      if (session.tts === socket) session.ttsOpen = false;
    };
  });
}

function ensureAudio() {
  if (session.audioCtx) return;
  const audioCtx = new AudioContext({ sampleRate: 48000 });
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  const silent = audioCtx.createGain();
  silent.gain.value = 0;
  analyser.connect(silent);
  silent.connect(audioCtx.destination);
  session.audioCtx = audioCtx;
  session.analyser = analyser;
  session.amplitudeTimer = setInterval(publishAmplitude, 80);
}

function playPcm(base64) {
  if (!session.running) return;
  ensureAudio();
  session.audioCtx.resume();
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const view = new Int16Array(bytes.buffer);
  const floats = new Float32Array(view.length);
  for (let i = 0; i < view.length; i += 1) floats[i] = view[i] / 32768;
  const buffer = session.audioCtx.createBuffer(1, floats.length, 24000);
  buffer.copyToChannel(floats, 0);
  const source = session.audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(session.analyser);
  const start = Math.max(session.audioCtx.currentTime, session.nextTime);
  source.start(start);
  session.nextTime = start + buffer.duration;
  session.sources.push(source);
  source.onended = () => {
    session.sources = session.sources.filter((item) => item !== source);
  };
  chrome.runtime.sendMessage({ type: "AUDIO_CHUNK", audio: base64 });
}

function interruptTutor() {
  session.dropModel = session.turnOpen;
  session.turnOpen = false;
  session.textBuffer = "";
  session.caption = "";
  shownCaption = "";
  clearTimeout(session.flushTimer);
  stopPlayback();
  chrome.runtime.sendMessage({ type: "CAPTION", text: "" });
}

function stopPlayback() {
  session.speakEpoch += 1;
  for (const source of session.sources) {
    try { source.stop(); } catch { /* already stopped */ }
  }
  session.sources = [];
  session.nextTime = 0;
}

function publishAmplitude() {
  if (!session.analyser || !session.audioCtx) return;
  const data = new Uint8Array(session.analyser.fftSize);
  session.analyser.getByteTimeDomainData(data);
  let sum = 0;
  for (const value of data) {
    const centered = (value - 128) / 128;
    sum += centered * centered;
  }
  const rms = Math.sqrt(sum / data.length);
  const talking = session.audioCtx.currentTime < session.nextTime - 0.05;
  chrome.runtime.sendMessage({
    type: "AMPLITUDE",
    value: talking ? Math.max(rms, 0.08) : 0,
    talking,
  });
  if (!talking && session.voiceDirty) session.voiceDirty = false;
}

function isTalking() {
  return Boolean(session.audioCtx && session.audioCtx.currentTime < session.nextTime - 0.05);
}

function requestedMode(text) {
  const said = text.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
  if (/\b(lock in|accountab|strict bunny|strict mode|be strict|hold me accountable|keep me honest|sois strict)\b/.test(said)) return "strict";
  if (/\b(nice bunny|nicer|more nice|be gentle|reassure|slow down|plus gentil|sois plus doux|sois plus douce)\b/.test(said)) return "nice";
  if (/\b(bunny buddy|regular mode|normal mode|be regular)\b/.test(said)) return "calm";
  return null;
}

function noteUserSpeech(text) {
  session.userHeard = `${session.userHeard} ${text}`.trim();
  const next = requestedMode(session.userHeard);
  if (!next) return;
  session.userHeard = "";
  session.voiceHold = next;
  session.debouncer.reset();
  applyMood(next, { defer: true });
}

async function applyMood(next, options = {}) {
  if (next !== "calm" && next !== "strict" && next !== "nice") return;
  if (next === session.mood && !session.voiceDirty && !options.defer) {
    chrome.runtime.sendMessage({ type: "MOOD", mood: next });
    return;
  }
  const changing = next !== session.mood;
  session.mood = next;
  chrome.runtime.sendMessage({ type: "MOOD", mood: next });
  if (options.announce && changing) {
    stopPlayback();
    session.turnOpen = false;
    session.textBuffer = "";
    session.caption = "";
    shownCaption = "";
    clearTimeout(session.flushTimer);
    chrome.runtime.sendMessage({ type: "CAPTION", text: "" });
    speak(next === "nice" ? "Hey. Let's slow down." : "Eyes on the page. Now.");
  }
  if (isTalking()) session.voiceDirty = true;
  if (!session.token) return;
  if (options.defer || (!options.announce && (session.turnOpen || isTalking()))) session.moodDirty = true;
  else await reconnectGemini();
}

function onFocusSample(sample) {
  if (!sample?.state) return;
  session.presageReady = true;
  session.lastFocusState = sample.state;
  session.lastScore = sample.score;
  if (sample.label) postPresage(sample.label);
  const result = session.debouncer.push(sample.state, Date.now());
  if (result.changed) {
    if (session.voiceHold === "strict" && result.mood === "calm") return;
    if (session.voiceHold === "nice" && result.mood === "calm") return;
    if (result.mood === "strict") session.voiceHold = null;
    if (result.mood === "calm" && session.stressed && session.voiceHold !== "strict") {
      applyMood("nice", { announce: true });
    } else {
      applyMood(result.mood, { announce: result.mood === "strict" });
    }
    logAttention(sample.state, sample.score, true);
  }
}

function onStressSample(sample) {
  session.stressed = Boolean(sample.stressed);
  postPresage(session.stressed ? "You seem stressed" : "Watching you");
  if (session.stressed) {
    if (session.mood === "strict" || session.voiceHold === "strict" || session.mood === "nice") return;
    applyMood("nice", { announce: true });
    return;
  }
  if (session.mood === "nice" && session.voiceHold !== "nice") applyMood("calm");
}

function connectPresage() {
  if (!session.running) return;
  try { session.presageWs?.close(); } catch { /* ignore */ }
  const socket = new WebSocket(config.presageWs);
  session.presageWs = socket;
  socket.onmessage = (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === "status") {
      session.presageReady = Boolean(message.ready);
      postStatus(message.ready ? "" : message.error || "");
    }
    if (message.type === "focus") onFocusSample(message);
    if (message.type === "stress") onStressSample(message);
  };
  socket.onclose = () => {
    if (!session.running || session.presageWs !== socket) return;
    session.presageReady = false;
    postStatus("");
    session.presageTimer = setTimeout(connectPresage, 3000);
  };
}

async function logAttention(state, score, isTransition) {
  if (!session.sessionId || !session.presageReady) return;
  try {
    await api("/api/event", {
      sessionId: session.sessionId,
      kind: "attention",
      state,
      score,
      isTransition,
      time: new Date().toISOString(),
    });
  } catch (error) {
    postStatus(error.message);
  }
}

async function startScreen(streamId) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
    video: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
  });
  session.screenStream = stream;
  session.screenVideo = await attachVideo(stream);
  session.screenTimer = setInterval(() => {
    if (!session.screenVideo || session.screenVideo.readyState < 2) return;
    const jpeg = grabJpeg(session.screenVideo, 768, 432, 0.55);
    sendGemini({ realtimeInput: { video: { mimeType: "image/jpeg", data: jpeg } } });
  }, SCREEN_INTERVAL_MS);
}

async function startMic() {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    video: false,
  });
  session.micStream = stream;
  ensureAudio();
  await session.audioCtx.audioWorklet.addModule(chrome.runtime.getURL("offscreen/pcm-processor.js"));
  const source = session.audioCtx.createMediaStreamSource(stream);
  const worklet = new AudioWorkletNode(session.audioCtx, "pcm-processor");
  worklet.port.onmessage = (event) => {
    if (!session.ptt) return;
    session.pcmQueue.push(event.data);
    session.pcmQueued += event.data.length;
    const rate = session.audioCtx.sampleRate;
    if (session.pcmQueued < rate * 0.1) return;
    const merged = new Float32Array(session.pcmQueued);
    let offset = 0;
    for (const chunk of session.pcmQueue) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    session.pcmQueue = [];
    session.pcmQueued = 0;
    const pcm = floatToPcm16(downsample(merged, rate, 16000));
    sendGemini({
      realtimeInput: {
        audio: { mimeType: "audio/pcm;rate=16000", data: pcm16ToBase64(pcm) },
      },
    });
  };
  source.connect(worklet);
  session.micSource = source;
  session.worklet = worklet;
}

async function startWebcam() {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: "user", width: 640, height: 480 },
    audio: false,
  });
  session.webcamStream = stream;
  session.webcamVideo = await attachVideo(stream);
  session.webcamTimer = setInterval(() => {
    if (!session.webcamVideo || session.webcamVideo.readyState < 2) return;
    if (session.presageWs?.readyState !== WebSocket.OPEN) return;
    const jpeg = grabJpeg(session.webcamVideo, 640, 480, 0.7);
    session.presageWs.send(JSON.stringify({ type: "frame", jpeg }));
  }, WEBCAM_INTERVAL_MS);
}

async function logQuestion() {
  if (!session.sessionId) return;
  try {
    await api("/api/event", {
      sessionId: session.sessionId,
      kind: "question",
      mode: session.mood,
      time: new Date().toISOString(),
    });
  } catch (error) {
    postStatus(error.message);
  }
}

function beginPtt() {
  if (!session.running || session.ptt) return;
  session.audioCtx?.resume();
  session.ptt = true;
  session.epoch += 1;
  session.acceptEpoch = null;
  session.textBuffer = "";
  session.caption = "";
  stopPlayback();
  chrome.runtime.sendMessage({ type: "CAPTION", text: "Listening…" });
  sendGemini({ realtimeInput: { activityStart: {} } });
}

async function endPtt() {
  if (!session.ptt) return;
  session.ptt = false;
  session.acceptEpoch = session.epoch;
  sendGemini({ realtimeInput: { activityEnd: {} } });
}

async function startSession(message) {
  if (session.running) await stopSession();
  session.running = true;
  session.streamId = message.streamId;
  session.tabId = message.tabId;
  session.mood = "calm";
  session.debouncer.reset();
  session.caption = "";
  try {
    await startScreen(message.streamId);
  } catch (error) {
    session.running = false;
    postStatus(error.message);
    return { ok: false, error: error.message };
  }
  try {
    const tokenResult = await api("/api/gemini/token", {});
    session.token = tokenResult.token;
    const retired = tokenResult.model === "gemini-live-2.5-flash-preview";
    session.geminiModel = retired ? GEMINI_MODEL_FALLBACK : (tokenResult.model || GEMINI_MODEL_FALLBACK);
    await openGemini("calm");
    session.epoch += 1;
    session.acceptEpoch = session.epoch;
    session.turnOpen = false;
  } catch (error) {
    session.running = false;
    postStatus(error.message);
    return { ok: false, error: error.message };
  }
  try {
    session.ttsConfig = await api("/api/tts/config", {});
  } catch (error) {
    postStatus(error.message);
  }

  try {
    await startWebcam();
    connectPresage();
  } catch (error) {
    postStatus("Camera was blocked, so calm and strict will not switch on their own. Just talk, and Bunny Buddy will answer.");
  }

  try {
    const started = await api("/api/session/start", {});
    session.sessionId = started.sessionId;
  } catch (error) {
    postStatus(error.message);
  }

  session.sampleTimer = setInterval(() => {
    if (!session.lastFocusState) return;
    logAttention(session.lastFocusState, session.lastScore, false);
  }, ATTENTION_SAMPLE_MS);

  if (!session.ttsConfig?.apiKey && session.geminiReady) {
    postStatus("Set ELEVENLABS_API_KEY in web/.env.local so the mascot can talk.");
  }
  return { ok: true };
}

async function stopSession() {
  session.running = false;
  clearInterval(session.screenTimer);
  clearInterval(session.webcamTimer);
  clearInterval(session.sampleTimer);
  clearInterval(session.amplitudeTimer);
  clearTimeout(session.presageTimer);
  clearTimeout(session.flushTimer);
  stopPlayback();
  session.gemini?.close();
  session.tts?.close();
  session.presageWs?.close();
  for (const stream of [session.screenStream, session.micStream, session.webcamStream]) {
    stream?.getTracks().forEach((track) => track.stop());
  }
  session.screenVideo?.remove();
  session.webcamVideo?.remove();
  if (session.sessionId) {
    try {
      await api("/api/session/end", { sessionId: session.sessionId });
    } catch {
      // Stopping should still tear the media down if logging fails.
    }
  }
  session.sessionId = "";
  session.geminiReady = false;
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const reply = (promise) => {
    promise.then(
      (result) => sendResponse(result ?? { ok: true }),
      (error) => sendResponse({ ok: false, error: error.message }),
    );
    return true;
  };
  if (message.type === "OFFSCREEN_PING") {
    sendResponse({ pong: true });
    return false;
  }
  if (message.type === "START_SESSION") return reply(startSession(message));
  if (message.type === "STOP_SESSION") return reply(stopSession());
  if (message.type === "PTT_START") beginPtt();
  if (message.type === "PTT_END") endPtt();
  if (message.type === "INTERRUPT") interruptTutor();
  if (message.type === "MIC_CHUNK" && session.running && session.geminiReady && message.audio) {
    const playing = session.audioCtx && session.audioCtx.currentTime < session.nextTime + 0.4;
    if (!playing) {
      sendGemini({
        realtimeInput: {
          audio: { mimeType: "audio/pcm;rate=16000", data: message.audio },
        },
      });
    }
  }
  if (message.type === "PREVIEW_MOOD") applyMood(message.mood);
  return false;
});

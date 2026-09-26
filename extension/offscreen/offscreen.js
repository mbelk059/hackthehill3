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
const GEMINI_MODEL_FALLBACK = "gemini-live-2.5-flash-preview";

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
  textBuffer: "",
  caption: "",
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
  debouncer: createMoodDebouncer(),
};

function postStatus(error) {
  chrome.runtime.sendMessage({
    type: "STATUS",
    error: error || "",
    presage: {
      ready: session.presageReady,
      detail: session.presageReady ? "Presage connected" : "Presage offline — mood preview still works",
    },
  });
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
  return `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?access_token=${encodeURIComponent(token)}`;
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
    socket.onclose = () => {
      if (session.gemini === socket) session.geminiReady = false;
    };
    socket.onopen = () => {
      socket.send(JSON.stringify({
        setup: {
          model: `models/${session.geminiModel}`,
          generationConfig: { responseModalities: ["TEXT"] },
          systemInstruction: { parts: [{ text: PROMPTS[mood] || PROMPTS.calm }] },
          realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
        },
      }));
    };
  });
}

function handleGeminiContent(message) {
  const server = message.serverContent;
  if (!server) return;
  if (session.acceptEpoch !== session.epoch) return;
  const parts = server.modelTurn?.parts || [];
  for (const part of parts) {
    if (!part.text) continue;
    session.caption += part.text;
    chrome.runtime.sendMessage({ type: "CAPTION", text: session.caption });
    const split = takeSentences(session.textBuffer, part.text, false);
    session.textBuffer = split.buffer;
    for (const sentence of split.sentences) speak(sentence);
  }
  if (server.turnComplete) {
    const split = takeSentences(session.textBuffer, "", true);
    session.textBuffer = split.buffer;
    for (const sentence of split.sentences) speak(sentence);
    session.acceptEpoch = null;
    if (session.moodDirty) {
      session.moodDirty = false;
      reconnectGemini();
    }
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

function speak(sentence) {
  if (!session.tts || session.tts.readyState !== WebSocket.OPEN) return;
  session.tts.send(JSON.stringify({ text: `${sentence} `, flush: true }));
}

function ttsUrl(voiceId, modelId) {
  const params = new URLSearchParams({
    model_id: modelId || "eleven_flash_v2_5",
    output_format: "pcm_24000",
  });
  return `wss://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input?${params}`;
}

function openTts(mood) {
  const configTts = session.ttsConfig;
  if (!configTts?.apiKey) return Promise.resolve();
  if (session.tts) {
    try { session.tts.close(); } catch { /* already closed */ }
  }
  const voiceId = mood === "strict" ? configTts.voiceStrict : configTts.voiceCalm;
  return new Promise((resolve) => {
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
      resolve();
    };
    socket.onmessage = (event) => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.audio) playPcm(message.audio);
      if (message.error) postStatus(message.error);
    };
    socket.onerror = () => postStatus("ElevenLabs socket failed.");
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
  analyser.connect(audioCtx.destination);
  session.audioCtx = audioCtx;
  session.analyser = analyser;
  session.amplitudeTimer = setInterval(publishAmplitude, 80);
}

function playPcm(base64) {
  ensureAudio();
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
}

function stopPlayback() {
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
  if (!talking && session.voiceDirty) {
    session.voiceDirty = false;
    openTts(session.mood);
  }
}

function isTalking() {
  return Boolean(session.audioCtx && session.audioCtx.currentTime < session.nextTime - 0.05);
}

async function applyMood(next) {
  if (next !== "calm" && next !== "strict") return;
  if (next === session.mood && !session.voiceDirty) {
    chrome.runtime.sendMessage({ type: "MOOD", mood: next });
    return;
  }
  session.mood = next;
  chrome.runtime.sendMessage({ type: "MOOD", mood: next });
  if (isTalking()) session.voiceDirty = true;
  else await openTts(next);
  if (!session.token) return;
  if (session.ptt || session.acceptEpoch != null) session.moodDirty = true;
  else await reconnectGemini();
}

function onFocusSample(sample) {
  if (!sample?.state) return;
  session.presageReady = true;
  session.lastFocusState = sample.state;
  session.lastScore = sample.score;
  const result = session.debouncer.push(sample.state, Date.now());
  if (result.changed) {
    applyMood(result.mood);
    logAttention(sample.state, sample.score, true);
  }
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
    audio: false,
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

function beginPtt() {
  if (!session.running || session.ptt) return;
  session.ptt = true;
  session.epoch += 1;
  session.acceptEpoch = null;
  session.textBuffer = "";
  session.caption = "";
  stopPlayback();
  chrome.runtime.sendMessage({ type: "CAPTION", text: "" });
  sendGemini({ realtimeInput: { activityStart: {} } });
}

async function endPtt() {
  if (!session.ptt) return;
  session.ptt = false;
  session.acceptEpoch = session.epoch;
  sendGemini({ realtimeInput: { activityEnd: {} } });
  if (session.sessionId) {
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
}

async function startSession(message) {
  if (session.running) return { ok: true };
  session.running = true;
  session.streamId = message.streamId;
  session.tabId = message.tabId;
  session.mood = "calm";
  session.debouncer.reset();
  session.caption = "";
  try {
    const tokenResult = await api("/api/gemini/token", {});
    session.token = tokenResult.token;
    session.geminiModel = tokenResult.model || GEMINI_MODEL_FALLBACK;
    await openGemini("calm");
  } catch (error) {
    postStatus(error.message);
  }
  try {
    session.ttsConfig = await api("/api/tts/config", {});
    await openTts("calm");
  } catch (error) {
    postStatus(error.message);
  }
  try {
    await startScreen(message.streamId);
  } catch (error) {
    session.running = false;
    session.gemini?.close();
    session.tts?.close();
    postStatus(error.message);
    return { ok: false, error: error.message };
  }

  try {
    await startMic();
  } catch (error) {
    postStatus(`Microphone unavailable: ${error.message}`);
  }
  try {
    await startWebcam();
    connectPresage();
  } catch (error) {
    postStatus(`Webcam unavailable: ${error.message}`);
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
  if (message.type === "OFFSCREEN_PING") {
    sendResponse({ pong: true });
    return false;
  }
  if (message.type === "START_SESSION") {
    startSession(message).then(sendResponse);
    return true;
  }
  if (message.type === "STOP_SESSION") {
    stopSession().then(sendResponse);
    return true;
  }
  if (message.type === "PTT_START") beginPtt();
  if (message.type === "PTT_END") endPtt();
  if (message.type === "PREVIEW_MOOD") applyMood(message.mood);
  return false;
});

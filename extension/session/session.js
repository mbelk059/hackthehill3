import { downsample, floatToPcm16 } from "../lib/session-logic.mjs";
import { config } from "../config.js";

const statusEl = document.querySelector("#status");
const errorEl = document.querySelector("#error");
const startButton = document.querySelector("#start");
const stopButton = document.querySelector("#stop");
const tools = document.querySelector("#tools");
const calmButton = document.querySelector("#mode-calm");
const strictButton = document.querySelector("#mode-strict");
const presageEl = document.querySelector("#presage");
let localError = "";
let statusNote = "";
let starting = false;
let micStream = null;
let micSource = null;
let micNode = null;
let audioCtx = null;
let workletReady = false;
let talking = false;
let pcmQueue = [];
let pcmQueued = 0;

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function releaseMic() {
  talking = false;
  micSource?.disconnect();
  micNode?.disconnect();
  micSource = null;
  micNode = null;
  micStream?.getTracks().forEach((track) => track.stop());
  micStream = null;
  pcmQueue = [];
  pcmQueued = 0;
}

async function armMicrophone({ camera = true } = {}) {
  if (!audioCtx) audioCtx = new AudioContext();
  await audioCtx.resume();
  releaseMic();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  micStream = stream;
  if (camera) {
    try {
      const cam = await navigator.mediaDevices.getUserMedia({ video: true });
      cam.getTracks().forEach((track) => track.stop());
    } catch {
      // The tutor can still hear you if the camera stays off.
    }
  }
  if (!workletReady) {
    await audioCtx.audioWorklet.addModule(chrome.runtime.getURL("offscreen/pcm-processor.js"));
    workletReady = true;
  }
  micSource = audioCtx.createMediaStreamSource(stream);
  micNode = new AudioWorkletNode(audioCtx, "pcm-processor");
  micNode.port.onmessage = (event) => {
    if (!talking || !micStream) return;
    if (audioCtx.currentTime < voiceTime + 0.4) return;
    pcmQueue.push(event.data);
    pcmQueued += event.data.length;
    const rate = audioCtx.sampleRate;
    if (pcmQueued < rate * 0.1) return;
    const merged = new Float32Array(pcmQueued);
    let offset = 0;
    for (const piece of pcmQueue) {
      merged.set(piece, offset);
      offset += piece.length;
    }
    pcmQueue = [];
    pcmQueued = 0;
    const pcm = floatToPcm16(downsample(merged, rate, 16000));
    chrome.runtime.sendMessage({ type: "MIC_CHUNK", audio: bytesToBase64(new Uint8Array(pcm.buffer)) });
  };
  micSource.connect(micNode);
}

function showError(message) {
  errorEl.hidden = !message;
  errorEl.textContent = message || "";
}

function render(state) {
  if (!state) return;
  if (!starting) {
    statusEl.textContent = statusNote || (state.studying ? "Just talk! Say stop or arrête to cut in." : "Ready when you are!");
    startButton.textContent = "Let's go!";
  }
  startButton.hidden = state.studying;
  tools.hidden = !state.studying;
  const strict = state.mood === "strict";
  calmButton.classList.toggle("on", !strict);
  strictButton.classList.toggle("on", strict);
  mascotEl?.classList.toggle("strict", strict);
  presageEl.textContent = state.presage?.detail || "";
  showError(localError || state.lastError);
}

async function refresh() {
  const state = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  render(state);
}

function captureError(error) {
  const message = error?.message || "Could not start.";
  if (/not been invoked|cannot be captured|activeTab/i.test(message)) {
    return "Open your study website, click the Study Mascot icon on that tab, then click Start. Chrome’s own pages can’t be shared.";
  }
  if (/message channel closed|asynchronous response/i.test(message)) {
    return "Start was interrupted. Reload the extension, click the Study Mascot icon on Brightspace, then click Start again.";
  }
  return message;
}

async function sendToOffscreen(message) {
  let last = "The tutor did not start.";
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await chrome.runtime.sendMessage(message);
      if (response) return response;
    } catch (error) {
      last = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(last);
}

async function studyTab() {
  const state = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  if (!state?.invokedTabId) {
    throw new Error("Open your study website, click the Study Mascot icon on that tab, then click Start.");
  }
  let tab;
  try {
    tab = await chrome.tabs.get(state.invokedTabId);
  } catch {
    throw new Error("That tab was closed. Open your study website, click the Study Mascot icon, then click Start.");
  }
  if (!/^https?:\/\//i.test(tab.url || "")) {
    throw new Error("This is a Chrome page, so it can’t be shared. Open your study website, click the Study Mascot icon, then click Start.");
  }
  return tab;
}

async function mediaGranted() {
  try {
    const status = await navigator.permissions.query({ name: "microphone" });
    return status.state === "granted";
  } catch {
    return null;
  }
}

startButton.addEventListener("click", async () => {
  localError = "";
  statusNote = "";
  stopTutorAudio();
  voiceOn = true;
  starting = true;
  startButton.disabled = true;
  startButton.textContent = "Starting…";
  statusEl.textContent = "Starting…";
  showError("");
  if (!audioCtx) audioCtx = new AudioContext();
  audioCtx.resume();
  try {
    const granted = await mediaGranted();
    statusEl.textContent = granted === true ? "Turning on the microphone…" : "Choose Allow for the microphone.";
    await armMicrophone();
    const tab = await studyTab();
    if (!tab?.id) throw new Error("Open a normal website tab first, then click Start.");
    statusEl.textContent = `Sharing “${tab.title || "this tab"}”…`;
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    const prepared = await chrome.runtime.sendMessage({ type: "START", streamId, tabId: tab.id });
    if (!prepared?.ok) throw new Error(prepared?.error || "Could not start.");
    statusEl.textContent = "Connecting the tutor…";
    const started = await sendToOffscreen({ type: "START_SESSION", streamId, tabId: tab.id });
    if (!started?.ok) {
      await chrome.runtime.sendMessage({ type: "STOP" });
      throw new Error(started?.error || "Could not start the tutor.");
    }
    talking = true;
    statusEl.textContent = "Just talk! Say stop or arrête to cut in.";
  } catch (error) {
    localError = captureError(error);
    stopTutorAudio();
    stopInterruptListener();
    statusEl.textContent = "Start failed.";
  } finally {
    starting = false;
    startButton.disabled = false;
    startButton.textContent = "Let's go!";
    await refresh();
  }
});

stopButton.addEventListener("click", async () => {
  stopTutorAudio();
  stopInterruptListener();
  talking = false;
  releaseMic();
  await chrome.runtime.sendMessage({ type: "STOP" });
  captionEl.hidden = true;
  captionEl.textContent = "";
  await refresh();
});

let voiceTime = 0;
let voiceOn = false;
const voiceSources = [];

function stopTutorAudio() {
  voiceOn = false;
  for (const source of voiceSources) {
    try { source.stop(); } catch { /* already stopped */ }
  }
  voiceSources.length = 0;
  voiceTime = 0;
}

function buddyTalking() {
  return voiceSources.length > 0 || Boolean(audioCtx && audioCtx.currentTime < voiceTime + 0.2);
}

function playTutor(base64) {
  if (!voiceOn) return;
  if (!audioCtx) audioCtx = new AudioContext();
  audioCtx.resume();
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  const view = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  const floats = new Float32Array(view.length);
  for (let i = 0; i < view.length; i += 1) floats[i] = view[i] / 32768;
  if (!floats.length || !voiceOn) return;
  const buffer = audioCtx.createBuffer(1, floats.length, 24000);
  buffer.copyToChannel(floats, 0);
  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(audioCtx.destination);
  const start = Math.max(audioCtx.currentTime + 0.05, voiceTime);
  source.start(start);
  voiceSources.push(source);
  source.onended = () => {
    const index = voiceSources.indexOf(source);
    if (index >= 0) voiceSources.splice(index, 1);
  };
  voiceTime = start + buffer.duration;
  listenForCutIn();
}

const mascotEl = document.querySelector("#mascot");
const captionEl = document.querySelector("#caption");
let interruptRec = null;
let interruptOn = false;
let cutting = false;
let rearm = null;
let playbackWatch = null;

function isCutIn(text) {
  const said = text.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");
  return /\b(stop|arret|arrete|arrette|arretes|arete)\b/.test(said);
}

function pauseMic() {
  micSource?.disconnect();
  micNode?.disconnect();
  micSource = null;
  micNode = null;
  micStream?.getTracks().forEach((track) => track.stop());
  micStream = null;
  pcmQueue = [];
  pcmQueued = 0;
}

function resumeMic() {
  if (!voiceOn || micStream) {
    if (voiceOn && micStream) talking = true;
    return Promise.resolve();
  }
  if (!rearm) {
    rearm = armMicrophone({ camera: false }).then(() => {
      talking = voiceOn;
    }).finally(() => {
      rearm = null;
    });
  }
  return rearm;
}

function listenForCutIn() {
  if (interruptOn || !voiceOn) return;
  const Rec = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;
  if (!Rec) return;
  interruptOn = true;
  pauseMic();
  if (!interruptRec) {
    const rec = new Rec();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = "fr-CA";
    rec.onresult = (event) => {
      const latest = event.results[event.results.length - 1];
      const said = latest?.[0]?.transcript || "";
      if (isCutIn(said)) interruptBuddy();
    };
    rec.onerror = () => {};
    rec.onend = () => {
      if (!interruptOn || !buddyTalking()) return;
      try { rec.start(); } catch { /* already running */ }
    };
    interruptRec = rec;
  }
  setTimeout(() => {
    if (!interruptOn || !voiceOn) return;
    try { interruptRec.start(); } catch { /* already started */ }
  }, 80);
  if (!playbackWatch) {
    playbackWatch = setInterval(() => {
      if (!voiceOn || !interruptOn) {
        clearInterval(playbackWatch);
        playbackWatch = null;
        return;
      }
      if (!buddyTalking()) finishCutIn();
    }, 150);
  }
}

function finishCutIn() {
  if (!interruptOn) return;
  interruptOn = false;
  clearInterval(playbackWatch);
  playbackWatch = null;
  try { interruptRec?.stop(); } catch { /* already stopped */ }
  if (voiceOn) resumeMic();
}

function stopInterruptListener() {
  interruptOn = false;
  clearInterval(playbackWatch);
  playbackWatch = null;
  try { interruptRec?.abort(); } catch { /* already stopped */ }
}

function interruptBuddy() {
  if (cutting || !voiceOn) return;
  cutting = true;
  interruptOn = false;
  clearInterval(playbackWatch);
  playbackWatch = null;
  try { interruptRec?.abort(); } catch { /* already stopped */ }
  for (const source of voiceSources) {
    try { source.stop(); } catch { /* already stopped */ }
  }
  voiceSources.length = 0;
  voiceTime = 0;
  captionEl.hidden = true;
  captionEl.textContent = "";
  statusEl.textContent = "Go ahead!";
  chrome.runtime.sendMessage({ type: "INTERRUPT" });
  resumeMic();
  setTimeout(() => { cutting = false; }, 800);
}

function chooseMode(mood) {
  chrome.runtime.sendMessage({ type: "PREVIEW_MOOD", mood });
  mascotEl.classList.toggle("strict", mood === "strict");
  calmButton.classList.toggle("on", mood !== "strict");
  strictButton.classList.toggle("on", mood === "strict");
}

calmButton.addEventListener("click", () => chooseMode("calm"));
strictButton.addEventListener("click", () => chooseMode("strict"));

document.querySelector("#dashboard").addEventListener("click", () => {
  chrome.tabs.create({ url: `${config.apiBase}/dashboard` });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "AUDIO_CHUNK" && message.audio) playTutor(message.audio);
  if (message.type === "CAPTION") {
    captionEl.hidden = !message.text;
    captionEl.textContent = message.text || "";
  }
  if (message.type === "MOOD") mascotEl.classList.toggle("strict", message.mood === "strict");
});

refresh();
setInterval(refresh, 1000);

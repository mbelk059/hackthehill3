import { downsample, floatToPcm16 } from "../lib/session-logic.mjs";

const statusEl = document.querySelector("#status");
const errorEl = document.querySelector("#error");
const startButton = document.querySelector("#start");
const stopButton = document.querySelector("#stop");
const moodRow = document.querySelector("#mood-row");
const moodLabel = document.querySelector("#mood-label");
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

async function armMicrophone() {
  if (!audioCtx) audioCtx = new AudioContext();
  await audioCtx.resume();
  releaseMic();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  micStream = stream;
  try {
    const camera = await navigator.mediaDevices.getUserMedia({ video: true });
    camera.getTracks().forEach((track) => track.stop());
  } catch {
    // The tutor can still hear you if the camera stays off.
  }
  if (!workletReady) {
    await audioCtx.audioWorklet.addModule(chrome.runtime.getURL("offscreen/pcm-processor.js"));
    workletReady = true;
  }
  micSource = audioCtx.createMediaStreamSource(stream);
  micNode = new AudioWorkletNode(audioCtx, "pcm-processor");
  micNode.port.onmessage = (event) => {
    if (!talking || !micStream) return;
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
    statusEl.textContent = statusNote || (state.studying
      ? "Studying. Hold the mascot, ask out loud, then let go. It answers in a voice."
      : "Click Start. If Chrome asks, choose Allow.");
    startButton.textContent = "Start studying";
  }
  startButton.hidden = state.studying;
  stopButton.hidden = !state.studying;
  moodRow.hidden = !state.studying;
  moodLabel.textContent = state.mood === "strict" ? "Strict" : "Calm";
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
    statusEl.textContent = "Hold the mascot, ask your question, then let go. It answers out loud.";
  } catch (error) {
    localError = captureError(error);
    statusEl.textContent = "Start failed.";
  } finally {
    starting = false;
    startButton.disabled = false;
    startButton.textContent = "Start studying";
    await refresh();
  }
});

stopButton.addEventListener("click", async () => {
  releaseMic();
  await chrome.runtime.sendMessage({ type: "STOP" });
  await refresh();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "PTT_START") {
    talking = Boolean(micStream);
    audioCtx?.resume();
    if (!micStream) localError = "The microphone is off. Click Start studying and choose Allow.";
  }
  if (message.type === "PTT_END") talking = false;
});

document.querySelector("#preview-calm").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "PREVIEW_MOOD", mood: "calm" });
  await refresh();
});

document.querySelector("#preview-strict").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "PREVIEW_MOOD", mood: "strict" });
  await refresh();
});

refresh();
setInterval(refresh, 1000);

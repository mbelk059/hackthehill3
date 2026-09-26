import fs from "node:fs";
import http from "node:http";
import { WebSocketServer } from "ws";
import jpeg from "jpeg-js";
import { interpretValidation } from "./focus.mjs";

function loadEnv() {
  const file = new URL("./.env", import.meta.url);
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const splitAt = trimmed.indexOf("=");
    if (splitAt === -1) continue;
    const key = trimmed.slice(0, splitAt).trim();
    const value = trimmed.slice(splitAt + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnv();

const port = Number(process.env.PORT || 8787);
const clients = new Set();
let sdk = null;
let pixelFormat = null;
let ready = false;
let acceptingFrames = false;
let statusError = "";
let lastUs = 0;
let lastCode = "";
let frameTransform = 0;
let restarting = false;

function timestampUs() {
  let us = Number(process.hrtime.bigint() / 1000n);
  if (us <= lastUs) us = lastUs + 1;
  lastUs = us;
  return us;
}

function broadcast(message) {
  const data = JSON.stringify(message);
  for (const client of clients) {
    if (client.readyState === 1) client.send(data);
  }
}

function statusMessage() {
  return {
    type: "status",
    ready,
    source: ready ? "presage" : "offline",
    error: statusError,
  };
}

async function startSdk() {
  if (!process.env.PRESAGE_API_KEY) {
    ready = false;
    statusError = "Set PRESAGE_API_KEY in presage-sidecar/.env";
    return;
  }
  try {
    const presage = await import("@smartspectra/node-sdk");
    pixelFormat = presage.PixelFormat;
    sdk = new presage.SmartSpectraSDK({
      apiKey: process.env.PRESAGE_API_KEY,
      requestedMetrics: [...presage.faceMetrics],
    });
    sdk.on("validationStatus", (code, _timestamp, hint) => {
      const focus = interpretValidation(code);
      if (focus.code !== lastCode) {
        lastCode = focus.code;
        console.log(`Presage ${focus.code} ${focus.state || ""} ${focus.label || hint || ""}`.trim());
      }
      broadcast({
        type: "focus",
        source: "presage",
        hint: hint || "",
        ...focus,
      });
    });
    sdk.on("processingStatus", (status) => {
      console.log("Presage processing status", status);
      if (status === 3) acceptingFrames = true;
      if (status === 4 || status === 5) {
        acceptingFrames = false;
        if (status === 5) recoverSdk();
      }
    });
    sdk.on("error", (_code, message) => {
      acceptingFrames = false;
      statusError = message || "Presage error";
      console.error("Presage error", statusError);
      recoverSdk();
    });
    frameTransform = presage.FrameTransform.kNone;
    sdk.useCustomInput(frameTransform);
    sdk.start();
    acceptingFrames = sdk.processingStatus !== 4 && sdk.processingStatus !== 5;
    console.log("Presage status after start", sdk.processingStatus, "accepting", acceptingFrames);
    ready = true;
    statusError = "";
  } catch (error) {
    ready = false;
    sdk = null;
    statusError = error.message;
  }
}

function recoverSdk() {
  if (restarting || !sdk) return;
  restarting = true;
  acceptingFrames = false;
  setTimeout(() => {
    try {
      sdk.reset();
      sdk.useCustomInput(frameTransform);
      sdk.start();
      lastUs = 0;
      lastCode = "";
      acceptingFrames = sdk.processingStatus !== 4 && sdk.processingStatus !== 5;
      statusError = "";
      ready = true;
      console.log("Presage restarted", sdk.processingStatus);
      broadcast(statusMessage());
    } catch (error) {
      statusError = error.message;
      console.error("Presage restart failed", statusError);
      broadcast(statusMessage());
    }
    restarting = false;
  }, 400);
}

function pushFrame(jpegBase64) {
  if (!sdk || !ready || !acceptingFrames) return;
  const buffer = Buffer.from(jpegBase64, "base64");
  const decoded = jpeg.decode(buffer, { useTArray: true, maxResolutionInMP: 5 });
  const accepted = sdk.sendFrame(
    Buffer.from(decoded.data),
    decoded.width,
    decoded.height,
    decoded.width * 4,
    pixelFormat.kRGBA,
    timestampUs(),
  );
  if (!accepted) statusError = "Presage rejected a frame.";
}

const server = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ ok: true, ...statusMessage() }));
});

const wss = new WebSocketServer({ server });
wss.on("connection", (socket) => {
  clients.add(socket);
  socket.send(JSON.stringify(statusMessage()));
  socket.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (message.type === "frame" && message.jpeg) {
      try {
        pushFrame(message.jpeg);
      } catch (error) {
        statusError = error.message;
        socket.send(JSON.stringify(statusMessage()));
      }
    }
  });
  socket.on("close", () => clients.delete(socket));
});

await startSdk();
server.listen(port, "127.0.0.1", () => {
  console.log(`Presage sidecar on ws://127.0.0.1:${port} (${ready ? "sdk ready" : statusError})`);
});

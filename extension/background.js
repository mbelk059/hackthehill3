import { config } from "./config.js";

chrome.sidePanel.setOptions({ path: "session/session.html", enabled: true }).catch(() => {});
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});

let studying = false;
let studyTabId = null;
let invokedTabId = null;
let mood = "calm";
let presage = { ready: false, detail: "Not connected" };
let lastError = "";

async function hydrate() {
  const stored = await chrome.storage.session.get([
    "studying",
    "studyTabId",
    "invokedTabId",
    "mood",
    "presage",
    "lastError",
  ]);
  studying = Boolean(stored.studying);
  studyTabId = stored.studyTabId ?? null;
  if (invokedTabId == null) invokedTabId = stored.invokedTabId ?? null;
  mood = stored.mood || "calm";
  presage = stored.presage || presage;
  lastError = stored.lastError || "";
  if (/message channel closed|asynchronous response/i.test(lastError)) lastError = "";
}

function persist() {
  return chrome.storage.session.set({ studying, studyTabId, invokedTabId, mood, presage, lastError });
}

chrome.action.onClicked.addListener((tab) => {
  invokedTabId = tab?.id ?? null;
  if (tab?.id) chrome.sidePanel.open({ tabId: tab.id });
  persist();
});

const hydratePromise = hydrate();

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeJwtPayload(token) {
  try {
    const segment = token.split(".")[1];
    const json = atob(segment.replace(/-/g, "+").replace(/_/g, "/"));
    return JSON.parse(json);
  } catch {
    return {};
  }
}

async function getAuth() {
  const { auth } = await chrome.storage.session.get("auth");
  return auth || null;
}

async function getAccessToken() {
  const auth = await getAuth();
  if (!auth?.accessToken) return null;
  if (auth.accessToken === "dev") return "dev";
  if (Date.now() < auth.expiresAt - 30000) return auth.accessToken;
  if (!auth.refreshToken || !config.auth0Domain) return null;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: config.auth0ClientId,
    refresh_token: auth.refreshToken,
  });
  const response = await fetch(`https://${config.auth0Domain}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    await chrome.storage.session.remove("auth");
    return null;
  }
  const data = await response.json();
  const next = {
    ...auth,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || auth.refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  await chrome.storage.session.set({ auth: next });
  return next.accessToken;
}

async function login() {
  if (!config.auth0Domain || !config.auth0ClientId) {
    await chrome.storage.session.set({
      auth: {
        accessToken: "dev",
        email: "dev@localhost",
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      },
    });
    return { ok: true, email: "dev@localhost", dev: true };
  }

  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const verifier = base64url(verifierBytes);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = base64url(new Uint8Array(digest));
  const redirectUri = chrome.identity.getRedirectURL();
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.auth0ClientId,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  if (config.auth0Audience) params.set("audience", config.auth0Audience);

  const responseUrl = await chrome.identity.launchWebAuthFlow({
    url: `https://${config.auth0Domain}/authorize?${params}`,
    interactive: true,
  });
  if (!responseUrl) throw new Error("Login window closed.");
  const code = new URL(responseUrl).searchParams.get("code");
  const authError = new URL(responseUrl).searchParams.get("error_description");
  if (!code) throw new Error(authError || "Auth0 did not return a code.");

  const tokenResponse = await fetch(`https://${config.auth0Domain}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: config.auth0ClientId,
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    }),
  });
  const data = await tokenResponse.json();
  if (!tokenResponse.ok) throw new Error(data.error_description || "Token exchange failed.");

  const profile = data.id_token ? decodeJwtPayload(data.id_token) : {};
  const auth = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || "",
    expiresAt: Date.now() + data.expires_in * 1000,
    email: profile.email || profile.name || "signed in",
  };
  await chrome.storage.session.set({ auth });
  return { ok: true, email: auth.email, redirectUri };
}

async function logout() {
  if (studying) await stopStudy();
  await chrome.storage.session.remove("auth");
  return { ok: true };
}

async function ensureOffscreen() {
  const exists = await chrome.offscreen.hasDocument();
  if (exists) return;
  await chrome.offscreen.createDocument({
    url: "offscreen/offscreen.html",
    reasons: ["USER_MEDIA", "AUDIO_PLAYBACK"],
    justification: "Capture the study tab, microphone, and webcam, and play the tutor voice.",
  });
}

async function startStudy(message) {
  let token = await getAccessToken();
  if (!token && !config.auth0Domain) {
    await login();
    token = await getAccessToken();
  }
  if (!token) throw new Error("Log in first.");
  if (!message.streamId || !message.tabId) throw new Error("Missing tab capture.");
  lastError = "";
  await persist();

  await ensureOffscreen();
  try {
    await chrome.scripting.executeScript({
      target: { tabId: message.tabId },
      files: ["content/mascot.js"],
    });
  } catch {
    // The page may not allow scripts. The message below still reports that.
  }

  studying = true;
  studyTabId = message.tabId;
  mood = "calm";
  lastError = "";
  await persist();
  try {
    await chrome.tabs.sendMessage(message.tabId, { type: "MASCOT", visible: true, mood: "calm" });
  } catch {
    lastError = "Refresh the website tab, then click Start studying again.";
    await persist();
  }
  return { ok: true };
}

async function stopStudy() {
  studying = false;
  studyTabId = null;
  mood = "calm";
  await persist();
  if (await chrome.offscreen.hasDocument()) {
    try {
      await chrome.runtime.sendMessage({ type: "STOP_SESSION" });
    } catch {
      // The offscreen page may already be closing.
    }
    await chrome.offscreen.closeDocument();
  }
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(async (tab) => {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "MASCOT", visible: false });
    } catch {
      // This tab has no mascot.
    }
  }));
  return { ok: true };
}

async function snapshot() {
  await hydratePromise;
  const auth = await getAuth();
  return {
    ok: true,
    loggedIn: Boolean(auth?.accessToken),
    email: auth?.email || "",
    dev: auth?.accessToken === "dev",
    studying,
    invokedTabId,
    mood,
    presage,
    lastError,
    redirectUri: chrome.identity.getRedirectURL(),
    auth0Ready: Boolean(config.auth0Domain && config.auth0ClientId),
  };
}

async function relayToTab(message) {
  if (!studyTabId) return;
  try {
    await chrome.tabs.sendMessage(studyTabId, message);
  } catch {
    // The tab navigated or closed.
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "START_SESSION" || message.type === "STOP_SESSION" || message.type === "PTT_START" || message.type === "PTT_END" || message.type === "MIC_CHUNK" || message.type === "PREVIEW_MOOD" || message.type === "OFFSCREEN_PING") {
    return false;
  }
  handle(message, sender)
    .then((result) => sendResponse(result ?? { ok: true }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function handle(message, sender) {
  await hydratePromise;

  if (message.type === "GET_STATE") return snapshot();
  if (message.type === "GET_TOKEN") {
    const token = await getAccessToken();
    return { ok: Boolean(token), token };
  }
  if (message.type === "LOGIN") return login();
  if (message.type === "LOGOUT") return logout();
  if (message.type === "START") {
    try {
      return await startStudy(message);
    } catch (error) {
      lastError = error.message;
      await persist();
      throw error;
    }
  }
  if (message.type === "STOP") return stopStudy();
  if (message.type === "MASCOT_HELLO") {
    const visible = studying && sender.tab?.id === studyTabId;
    return { visible, mood };
  }
  if (message.type === "MOOD") {
    mood = message.mood;
    await persist();
    await relayToTab(message);
    return { ok: true };
  }
  if (message.type === "STATUS") {
    if (message.presage) presage = message.presage;
    if (typeof message.error === "string") {
      lastError = message.error;
      if (message.error) relayToTab({ type: "CAPTION", text: message.error });
    }
    await persist();
    return { ok: true };
  }
  if (message.type === "AMPLITUDE" || message.type === "CAPTION" || message.type === "MASCOT" || message.type === "AUDIO_CHUNK") {
    await relayToTab(message);
    return { ok: true };
  }
  return { ok: true };
}

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === studyTabId) stopStudy();
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (tabId === studyTabId && info.status === "complete") {
    relayToTab({ type: "MASCOT", visible: true, mood });
  }
});

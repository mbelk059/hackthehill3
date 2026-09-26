const statusEl = document.querySelector("#status");
const errorEl = document.querySelector("#error");
const loggedOut = document.querySelector("#logged-out");
const loggedIn = document.querySelector("#logged-in");
const startButton = document.querySelector("#start");
const stopButton = document.querySelector("#stop");
const moodRow = document.querySelector("#mood-row");
const moodLabel = document.querySelector("#mood-label");
const presageEl = document.querySelector("#presage");
const redirectEl = document.querySelector("#redirect");
const loginButton = document.querySelector("#login");

let localError = "";

function showError(message) {
  localError = message || "";
  const text = localError;
  errorEl.hidden = !text;
  errorEl.textContent = text;
}

function render(state) {
  const signedIn = state.loggedIn;
  loggedOut.hidden = signedIn;
  loggedIn.hidden = !signedIn;
  statusEl.textContent = signedIn ? state.email : "Sign in to study";
  loginButton.textContent = state.auth0Ready ? "Log in with Auth0" : "Continue in dev mode";
  redirectEl.textContent = state.auth0Ready
    ? `Auth0 callback: ${state.redirectUri}`
    : "Auth0 is empty in config.js, so this uses the local dev login.";
  startButton.hidden = false;
  startButton.textContent = "Open study window";
  stopButton.hidden = !state.studying;
  moodRow.hidden = !state.studying;
  moodLabel.textContent = state.mood === "strict" ? "Strict" : "Calm";
  presageEl.textContent = state.presage?.detail || "";
  const message = localError || state.lastError || "";
  errorEl.hidden = !message;
  errorEl.textContent = message;
}

async function refresh() {
  const state = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  render(state);
  return state;
}

async function run(type, extra) {
  showError("");
  const result = await chrome.runtime.sendMessage({ type, ...extra });
  if (!result?.ok) showError(result?.error || "Something went wrong.");
  await refresh();
}

loginButton.addEventListener("click", () => run("LOGIN"));
document.querySelector("#logout").addEventListener("click", () => run("LOGOUT"));
document.querySelector("#stop").addEventListener("click", () => run("STOP"));
document.querySelector("#preview-calm").addEventListener("click", () => run("PREVIEW_MOOD", { mood: "calm" }));
document.querySelector("#preview-strict").addEventListener("click", () => run("PREVIEW_MOOD", { mood: "strict" }));

startButton.addEventListener("click", async () => {
  showError("");
  startButton.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: "OPEN_CONTROLS" });
    if (!result?.ok) showError(result?.error || "Could not open the study window.");
  } catch (error) {
    showError(error.message);
  } finally {
    startButton.disabled = false;
  }
});

refresh();
setInterval(refresh, 1000);

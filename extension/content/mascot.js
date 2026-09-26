if (window.top === window) {
  document.getElementById("study-mascot-root")?.remove();
  try {
    globalThis.__studyMascotCleanup?.();
  } catch {
    // The previous script belonged to an old extension reload.
  }

  let host = null;
  let sprite = null;
  let bubble = null;
  let hint = null;
  let talking = false;
  let visible = false;
  let holding = false;
  let audioCtx = null;
  let nextTime = 0;

  function pageAudio() {
    if (!audioCtx) audioCtx = new AudioContext();
    audioCtx.resume();
    return audioCtx;
  }

  function playChunk(base64) {
    const ctx = pageAudio();
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    const view = new Int16Array(bytes.buffer);
    const floats = new Float32Array(view.length);
    for (let i = 0; i < view.length; i += 1) floats[i] = view[i] / 32768;
    const buffer = ctx.createBuffer(1, floats.length, 24000);
    buffer.copyToChannel(floats, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    const start = Math.max(ctx.currentTime, nextTime);
    source.start(start);
    nextTime = start + buffer.duration;
  }

  function send(message) {
    if (!chrome.runtime?.id) {
      if (hint) hint.textContent = "Refresh this page, then start again.";
      return;
    }
    chrome.runtime.sendMessage(message);
  }

  function ensureHost() {
    if (host) return;
    host = document.createElement("div");
    host.id = "study-mascot-root";
    const shadow = host.attachShadow({ mode: "open" });
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = chrome.runtime.getURL("content/mascot.css");
    const wrap = document.createElement("div");
    wrap.className = "wrap";
    sprite = document.createElement("img");
    sprite.className = "sprite idle";
    sprite.alt = "Study mascot. Hold to talk.";
    sprite.src = chrome.runtime.getURL("assets/mascot/idle.png");
    hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = "Hold me or ` to talk";
    const stop = document.createElement("button");
    stop.className = "stop";
    stop.type = "button";
    stop.textContent = "Stop";
    stop.addEventListener("click", (event) => {
      event.stopPropagation();
      event.preventDefault();
      holding = false;
      setVisible(false);
      send({ type: "STOP" });
    });
    bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.hidden = true;
    wrap.append(bubble, sprite, hint, stop);
    shadow.append(link, wrap);
    document.documentElement.append(host);

    sprite.addEventListener("pointerdown", async (event) => {
      event.preventDefault();
      pageAudio();
      const state = await chrome.runtime.sendMessage({ type: "GET_STATE" }).catch(() => null);
      if (!state?.studying) {
        hint.textContent = "Open the side panel and click Start studying.";
        return;
      }
      holding = true;
      hint.textContent = "Listening…";
      sprite.setPointerCapture(event.pointerId);
      send({ type: "PTT_START" });
    });
    const release = () => {
      if (!holding) return;
      holding = false;
      hint.textContent = "Hold me or ` to talk";
      send({ type: "PTT_END" });
    };
    sprite.addEventListener("pointerup", release);
    sprite.addEventListener("pointercancel", release);
  }

  function setVisible(next) {
    visible = next;
    if (next) {
      ensureHost();
      host.hidden = false;
    } else if (host) {
      host.hidden = true;
      if (holding) {
        holding = false;
        chrome.runtime.sendMessage({ type: "PTT_END" });
      }
    }
  }

  let mouthTimer = null;
  let mouthOpen = false;

  function setTalking(next) {
    if (!sprite) return;
    talking = next;
    if (next) {
      if (mouthTimer) return;
      mouthTimer = setInterval(() => {
        mouthOpen = !mouthOpen;
        sprite.src = chrome.runtime.getURL(mouthOpen ? "assets/mascot/talk.png" : "assets/mascot/idle.png");
      }, 140);
      return;
    }
    clearInterval(mouthTimer);
    mouthTimer = null;
    mouthOpen = false;
    sprite.src = chrome.runtime.getURL("assets/mascot/idle.png");
    sprite.style.transform = "";
  }

  function onMessage(message) {
    if (message.type === "MASCOT") {
      setVisible(Boolean(message.visible));
      if (message.mood && sprite) sprite.classList.toggle("strict", message.mood === "strict");
    }
    if (message.type === "MOOD" && sprite) {
      sprite.classList.toggle("strict", message.mood === "strict");
    }
    if (message.type === "AMPLITUDE") setTalking(Boolean(message.talking), message.value);
    if (message.type === "CAPTION" && bubble) {
      bubble.textContent = message.text || "";
      bubble.hidden = !message.text;
    }
  }

  function onKeyDown(event) {
    if (!visible || event.code !== "Backquote" || event.repeat || holding) return;
    event.preventDefault();
    pageAudio();
    holding = true;
    if (hint) hint.textContent = "Listening…";
    send({ type: "PTT_START" });
  }

  function onKeyUp(event) {
    if (event.code !== "Backquote" || !holding) return;
    event.preventDefault();
    holding = false;
    if (hint) hint.textContent = "Hold me or ` to talk";
    send({ type: "PTT_END" });
  }

  chrome.runtime.onMessage.addListener(onMessage);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  globalThis.__studyMascotCleanup = () => {
    try {
      chrome.runtime.onMessage.removeListener(onMessage);
    } catch {
      // This copy is already disconnected.
    }
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    host?.remove();
  };

  chrome.runtime.sendMessage({ type: "MASCOT_HELLO" }, (state) => {
    if (chrome.runtime.lastError || !state?.visible) return;
    setVisible(true);
    if (sprite) sprite.classList.toggle("strict", state.mood === "strict");
  });
}

if (window.top === window && !globalThis.__studyMascotInstalled) {
  globalThis.__studyMascotInstalled = true;

  let host = null;
  let sprite = null;
  let bubble = null;
  let talking = false;
  let visible = false;
  let holding = false;

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
    sprite.src = chrome.runtime.getURL("assets/mascot/mascot.png");
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = "Hold me or ` to talk";
    bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.hidden = true;
    wrap.append(bubble, sprite, hint);
    shadow.append(link, wrap);
    document.documentElement.append(host);

    sprite.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      holding = true;
      sprite.setPointerCapture(event.pointerId);
      chrome.runtime.sendMessage({ type: "PTT_START" });
    });
    const release = () => {
      if (!holding) return;
      holding = false;
      chrome.runtime.sendMessage({ type: "PTT_END" });
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

  function setTalking(next, amplitude) {
    if (!sprite) return;
    talking = next;
    sprite.classList.toggle("idle", !next);
    if (next) {
      const amount = Math.min(1, amplitude || 0);
      sprite.style.transform = `translateY(${-4 - amount * 8}px) scale(${1 + amount * 0.06}, ${1 - amount * 0.14})`;
    } else {
      sprite.style.transform = "";
    }
  }

  chrome.runtime.onMessage.addListener((message) => {
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
  });

  window.addEventListener("keydown", (event) => {
    if (!visible || event.code !== "Backquote" || event.repeat || holding) return;
    event.preventDefault();
    holding = true;
    chrome.runtime.sendMessage({ type: "PTT_START" });
  });

  window.addEventListener("keyup", (event) => {
    if (event.code !== "Backquote" || !holding) return;
    event.preventDefault();
    holding = false;
    chrome.runtime.sendMessage({ type: "PTT_END" });
  });

  chrome.runtime.sendMessage({ type: "MASCOT_HELLO" }, (state) => {
    if (chrome.runtime.lastError || !state?.visible) return;
    setVisible(true);
    if (sprite) sprite.classList.toggle("strict", state.mood === "strict");
  });
}

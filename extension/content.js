// Raise Your Hand — content script.
// Reads the paused YouTube player, sends the current lecture + timestamp to the
// backend, and renders a course-aware answer as an ambient overlay (View) driven
// by the voice/gesture loop. Two halves: the View (all DOM/CSS) and the logic
// (gesture, STT, TTS, ask, follow-up) which drives it via View.* calls.
(() => {
  "use strict";
  if (window.__ryhInjected) return;
  window.__ryhInjected = true;

  // DEPLOY: set to your hosted https domain, e.g. "https://voice.yourdomain.com".
  // All three share it — Caddy path-routes /tts and /stt to the voice servers.
  // Leave "" for local dev (the three localhost ports below). Also add the domain
  // to host_permissions in manifest.json.
  const DEPLOY_HOST = "https://api.raise-your-hand.cloud";
  const BACKEND = DEPLOY_HOST || "http://localhost:8787";
  const TTS_BACKEND = DEPLOY_HOST || "http://localhost:8788"; // Kokoro neural-TTS
  const STT_BACKEND = DEPLOY_HOST || "http://localhost:8789"; // Whisper speech-to-text
  // Voice language: drives STT (rec.lang), the Kokoro voice + lang for the spoken
  // answer, the forced answer language, and the follow-up prompt/"no" detection.
  const LANGS = [
    { code: "en-US", label: "EN", name: "English", ttsLang: "en-us", voice: "am_michael",
      followUp: "Any other questions?", askMore: "Ask another", resume: "Resume ▶",
      noMore: /^(no|nope|nah|no thanks?|no thank you|that'?s all|that'?s it|i'?m good|im good|i'?m done|im done|nothing|nothing else|no more|no more questions?|all good|we'?re good|stop|thanks|thank you)\.?$/i },
    { code: "pt-BR", label: "PT", name: "Brazilian Portuguese", ttsLang: "pt-br", voice: "pm_alex",
      followUp: "Tem mais alguma pergunta?", askMore: "Outra pergunta", resume: "Continuar ▶",
      noMore: /^(n[ãa]o|nada|só isso|so isso|é isso|e isso|estou bem|tô bem|to bem|acabou|para|parar|obrigad[oa]|valeu|n[ãa]o obrigad[oa])\.?$/i },
  ];
  let sttLang = "en-US";
  const langEntry = () => LANGS.find((l) => l.code === sttLang) || LANGS[0];
  const HISTORY_RESET_GAP = 30; // seconds; a bigger seek starts a fresh session
  const HEARTBEAT_SECONDS = 30; // watch-time sampling interval

  // ---- state ----
  let course = null; // { ingested, courseTitle, lectures:[{index,videoId,title}] }
  let currentPlaylistId = null;
  let history = []; // [{question, answer}]
  let anchor = { videoId: null, time: 0 }; // session anchor for history reset
  let deviceId = null; // anonymous, persisted via chrome.storage.local
  let sessionId = genId("ses"); // a "pause session"; regenerated on reset

  let view = null;           // the ambient overlay
  let active = false;        // a Q&A turn is engaged
  let busy = false;          // an /ask request is in flight
  let preparing = false;
  let listening = false;
  let speakAnswers = true;   // speak answers aloud — user toggle in the dock (persisted)
  let followUpMode = false;  // listening for a "any other questions?" reply, not a fresh question
  let voiceTurn = false;     // this question came in by voice (→ voice follow-up) vs typed (→ buttons)
  let ignoreDictation = false; // drop a dictation result cancelled by a follow-up button
  let turnActive = false;    // suspend hand detection while a turn runs
  let recognition = null;
  let finalTranscript = "";
  let silenceTimer = null;
  let mediaRecorder = null, audioStream = null, audioCtx = null, vadTimer = null, speechDetected = false;
  let sessionFrame = null;   // screenshot of the paused video, first question of a session
  let handRaiseOn = false;

  function genId(prefix) {
    return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
  }
  function loadDeviceId() {
    try {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get("ryhDeviceId", (r) => {
          deviceId = r.ryhDeviceId || genId("dev");
          if (!r.ryhDeviceId) chrome.storage.local.set({ ryhDeviceId: deviceId });
        });
        return;
      }
    } catch (_) {}
    deviceId = genId("dev"); // fallback (e.g. injected test context)
  }
  function loadLang() {
    const fromNav = () => {
      const n = (navigator.language || "en").toLowerCase();
      const hit = LANGS.find((l) => l.code.toLowerCase() === n || l.code.slice(0, 2) === n.slice(0, 2));
      return hit ? hit.code : "en-US";
    };
    try {
      if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
        chrome.storage.local.get(["ryhLang", "ryhSpeak"], (r) => { sttLang = r.ryhLang || fromNav(); if (typeof r.ryhSpeak === "boolean") speakAnswers = r.ryhSpeak; if (view) { view.setLang(sttLang); view.setSpeak(speakAnswers); } });
        return;
      }
    } catch (_) {}
    sttLang = fromNav();
    if (view) view.setLang(sttLang);
  }

  // ---- dom helpers ----
  const video = () => document.querySelector("video.html5-main-video, video");
  const params = () => new URLSearchParams(location.search);
  const getVideoId = () => params().get("v");
  const getPlaylistId = () => params().get("list");
  const fmt = (s) => {
    s = Math.max(0, Math.floor(s));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    const p = (n) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`;
  };
  const lectureForVideo = (vid) =>
    course && course.lectures ? course.lectures.find((l) => l.videoId === vid) : null;

  // ==========================================================================
  //  View — the ambient overlay. All DOM/CSS live here. The logic drives it
  //  through the returned API; it knows nothing about gesture/STT/TTS/ask.
  // ==========================================================================
  function createView(host, h = {}) {
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host{ all:initial; }
        *{ box-sizing:border-box; font-family:ui-sans-serif,-apple-system,'Segoe UI',Roboto,sans-serif; }
        .layer{ position:absolute; inset:0; overflow:hidden; pointer-events:none;
          --amber:#e6a94d; --amber-ink:#f2c579; --chalk:#f1ece2;
          --serif:'Charter','Iowan Old Style','Palatino Linotype',Georgia,serif; --mono:ui-monospace,'SF Mono',Menlo,monospace; }
        .scrim{ position:absolute; inset:0; opacity:0; transition:opacity .5s ease;
          background:radial-gradient(120% 120% at 50% 42%,#0000 30%,#000000cc 100%); }
        .lower{ position:absolute; inset:0; opacity:0; transition:opacity .5s ease;
          background:linear-gradient(to top,#000000dd 12%,#0000 46%); }
        .el{ position:absolute; opacity:0; transition:opacity .45s ease, transform .45s ease; }

        .cue{ left:50%; bottom:76px; transform:translate(-50%,8px); display:flex; align-items:center; gap:9px;
          font-size:13px; color:#efe9de; background:#0c0f14c2; border:1px solid #ffffff1c; backdrop-filter:blur(6px);
          padding:8px 14px; border-radius:999px; box-shadow:0 8px 24px -12px #000; }
        .cue .key{ font-family:var(--mono); font-size:11px; color:#8a857b; border:1px solid #ffffff1f; border-radius:5px; padding:1px 6px; }

        .listen{ left:50%; top:44%; transform:translate(-50%,-50%) scale(.96); display:flex; flex-direction:column; align-items:center; gap:16px; }
        .ring{ width:88px; height:88px; border-radius:50%; position:relative; display:grid; place-items:center; }
        .ring::after{ content:""; position:absolute; inset:0; border-radius:50%; border:1.5px solid var(--amber); opacity:.5; animation:breathe 2.6s ease-in-out infinite; }
        .ring .dot{ width:13px; height:13px; border-radius:50%; background:var(--amber); box-shadow:0 0 26px 6px #e6a94d66; }
        .wave{ display:flex; gap:4px; height:20px; align-items:center; }
        .wave i{ width:3px; height:8px; background:var(--amber); border-radius:2px; animation:eq 1s ease-in-out infinite; }
        .wave i:nth-child(2){animation-delay:.12s} .wave i:nth-child(3){animation-delay:.24s}
        .wave i:nth-child(4){animation-delay:.36s} .wave i:nth-child(5){animation-delay:.48s} .wave i:nth-child(6){animation-delay:.6s}
        .said{ font-family:var(--serif); font-style:italic; font-size:clamp(15px,2vw,19px); color:#efe9de; text-align:center; max-width:32ch; min-height:1.4em; text-wrap:balance; text-shadow:0 1px 10px rgba(0,0,0,.6); }
        .lbl{ font-size:12px; letter-spacing:.14em; text-transform:uppercase; color:var(--amber); font-weight:600; }

        .answer{ left:0; right:0; bottom:0; padding:clamp(18px,4vw,40px) clamp(20px,6vw,72px) clamp(20px,4vw,40px); display:flex; flex-direction:column; gap:11px; transform:translateY(10px);
          background:linear-gradient(to top, rgba(8,10,13,.96) 0%, rgba(8,10,13,.9) 58%, rgba(8,10,13,.62) 86%, rgba(8,10,13,0) 100%); backdrop-filter:blur(4px); }
        .answer .who{ display:flex; align-items:center; gap:9px; font-size:11px; letter-spacing:.14em; text-transform:uppercase; color:var(--amber); font-weight:600; }
        .answer .who .spk{ display:inline-flex; gap:2px; align-items:flex-end; height:11px; }
        .answer .who .spk i{ width:2.5px; height:5px; background:var(--amber); border-radius:1px; animation:eq .9s ease-in-out infinite; }
        .answer .who .spk i:nth-child(2){animation-delay:.15s} .answer .who .spk i:nth-child(3){animation-delay:.3s}
        .answer p{ font-family:var(--serif); font-size:clamp(17px,2.4vw,24px); line-height:1.42; color:#f6f1e8; max-width:40ch; text-wrap:pretty; letter-spacing:-.005em; margin:0; text-shadow:0 1px 10px rgba(0,0,0,.55);
          max-height:34vh; overflow-y:auto; overscroll-behavior:contain; pointer-events:auto;
          scrollbar-width:thin; scrollbar-color:#e6a94d80 transparent; }
        .answer p::-webkit-scrollbar{ width:6px; }
        .answer p::-webkit-scrollbar-thumb{ background:#e6a94d66; border-radius:3px; }
        .answer .ts{ color:var(--amber-ink); text-decoration:underline; text-underline-offset:3px; text-decoration-thickness:1px; cursor:pointer; pointer-events:auto; }
        .answer .foot{ display:flex; align-items:center; gap:14px; }
        .answer .meta{ font-size:12px; color:#8a857b; font-variant-numeric:tabular-nums; }
        .fb{ display:flex; gap:6px; opacity:0; transition:opacity .4s ease .3s; pointer-events:auto; }
        .fb button{ background:none; border:none; cursor:pointer; font-size:14px; opacity:.55; transition:opacity .2s, transform .1s; padding:2px; }
        .fb button:hover{ opacity:1; } .fb button:active{ transform:scale(.9); } .fb .picked{ opacity:1; }
        .answer.done .fb{ opacity:1; }

        .followup{ left:50%; bottom:76px; transform:translate(-50%,8px); font-family:var(--serif); font-size:clamp(15px,2.1vw,20px); color:#efe9de; display:flex; gap:11px; align-items:center;
          background:#0c0f14cc; border:1px solid #ffffff1c; backdrop-filter:blur(6px); padding:9px 18px; border-radius:999px; box-shadow:0 10px 28px -14px #000; text-shadow:0 1px 8px rgba(0,0,0,.5); }
        .followup .mini{ display:inline-flex; gap:3px; } .followup .mini i{ width:3px; height:9px; background:var(--amber); border-radius:2px; animation:eq 1s ease-in-out infinite; }
        .followup .mini i:nth-child(2){animation-delay:.15s} .followup .mini i:nth-child(3){animation-delay:.3s}
        .followup button, .answer .fmore button{ font-family:ui-sans-serif,-apple-system,sans-serif; font-size:13px; font-weight:600; color:#efe9de; background:#ffffff14; border:1px solid #ffffff2e; border-radius:999px; padding:6px 14px; cursor:pointer; pointer-events:auto; transition:border-color .2s ease, background .2s ease; }
        .followup button:hover, .answer .fmore button:hover{ border-color:var(--amber); background:#e6a94d24; }
        .followup .fresume, .answer .fmore .fresume{ color:var(--amber-ink); }
        .answer .fmore{ display:flex; gap:8px; margin-left:auto; }
        .answer .who .stopspk{ display:none; margin-left:10px; font-size:11px; font-weight:600; color:#f0b6a0; background:#2a151566; border:1px solid #a5432f88; border-radius:999px; padding:2px 10px; cursor:pointer; pointer-events:auto; letter-spacing:0; text-transform:none; }
        .answer .who .stopspk:hover{ background:#a5432f66; border-color:#f0b6a0; }
        .layer.speaking .answer .who .stopspk{ display:inline-block; }

        .err, .statusline{ left:50%; bottom:118px; transform:translate(-50%,6px); font-size:13px; padding:8px 14px; border-radius:10px; opacity:0; transition:opacity .3s ease, transform .3s ease; max-width:min(90%,520px); text-align:center; }
        .err{ color:#f0b6a0; background:#2a1512d8; border:1px solid #a5432f66; }
        .statusline{ color:#cfd7cd; background:#12161ad8; border:1px solid #ffffff1a; }
        .layer.err .err{ opacity:1; transform:translate(-50%,0); }
        .layer.status .statusline{ opacity:1; transform:translate(-50%,0); }

        /* control dock — auto-hiding */
        .dock{ position:absolute; right:16px; bottom:14px; display:flex; align-items:center; gap:8px; pointer-events:auto;
          opacity:0; transform:translateY(6px); transition:opacity .3s ease, transform .3s ease; }
        .layer.hot .dock, .layer.armed[data-state="idle"] .dock{ opacity:1; transform:none; }
        .dock button, .dock select{ font-family:ui-sans-serif,-apple-system,sans-serif; font-size:13px; color:#efe9de; background:#0c0f14d8;
          border:1px solid #ffffff1f; border-radius:9px; padding:8px 12px; cursor:pointer; backdrop-filter:blur(6px); }
        .dock button:hover, .dock select:hover{ border-color:var(--amber); }
        .dock .start, .dock .prepare{ font-weight:600; display:flex; align-items:center; gap:7px; }
        .dock .start.on{ background:#b622241a; border-color:#b62324; color:#ffb3ae; }
        .dock select{ font-weight:600; -webkit-appearance:none; appearance:none; }
        .dock .icon{ padding:8px 10px; font-size:14px; }
        .dock .speak.off{ color:#8a857b; border-color:#ffffff14; }
        .dock .prepare{ display:none; } .dock .start{ display:none; }
        .layer.ready .dock .start{ display:flex; } .layer.can-prepare .dock .prepare{ display:flex; }
        .layer.live .dock .mic{ background:#b62324; border-color:#b62324; }

        .typeline{ position:absolute; left:50%; bottom:16px; transform:translate(-50%,10px); width:min(560px,84%); opacity:0; pointer-events:none; transition:opacity .3s ease, transform .3s ease; }
        .layer.typing .typeline{ opacity:1; transform:translate(-50%,0); pointer-events:auto; }
        .typeline input{ width:100%; font-family:var(--serif); font-size:16px; color:#f6f1e8; background:#0c0f14ee; border:1px solid #ffffff26; border-radius:12px; padding:13px 16px; outline:none; }
        .typeline input:focus{ border-color:var(--amber); }

        .layer[data-state="listening"] .scrim, .layer[data-state="thinking"] .scrim{ opacity:1; }
        .layer[data-state="answer"] .lower, .layer[data-state="followup"] .lower{ opacity:1; }
        .layer[data-state="listening"] .listen, .layer[data-state="thinking"] .listen{ opacity:1; transform:translate(-50%,-50%) scale(1); }
        .layer[data-state="answer"] .answer{ opacity:1; transform:translateY(0); }
        .layer[data-state="followup"] .followup{ opacity:1; transform:translate(-50%,0); }
        .layer.armed[data-state="idle"] .cue{ opacity:1; transform:translate(-50%,0); }

        @keyframes breathe{ 0%,100%{ transform:scale(1); opacity:.5 } 50%{ transform:scale(1.34); opacity:0 } }
        @keyframes eq{ 0%,100%{ height:6px; opacity:.6 } 50%{ height:18px; opacity:1 } }
        :focus-visible{ outline:2px solid var(--amber); outline-offset:2px; }
        @media (prefers-reduced-motion:reduce){ *{ animation:none!important; transition-duration:.001ms!important } }
      </style>
      <div class="layer" data-state="idle">
        <div class="scrim"></div><div class="lower"></div>
        <div class="el cue">✋ Raise your hand to ask <span class="key">⇧A</span></div>
        <div class="el listen">
          <div class="lbl">Listening</div>
          <div class="ring"><span class="dot"></span></div>
          <div class="wave"><i></i><i></i><i></i><i></i><i></i><i></i></div>
          <div class="said"></div>
        </div>
        <div class="el answer">
          <div class="who"><span class="spk"><i></i><i></i><i></i></span> Teaching assistant <button class="stopspk" title="Stop speaking">⏹ Stop</button></div>
          <p class="text"></p>
          <div class="foot">
            <span class="meta"></span>
            <span class="fb"><button data-r="1" title="Helpful">👍</button><button data-r="-1" title="Not helpful">👎</button></span>
            <span class="fmore"></span>
          </div>
        </div>
        <div class="el followup"></div>
        <div class="err"></div><div class="statusline"></div>
        <div class="typeline"><input placeholder="Type your question…" aria-label="Type your question"></div>
        <div class="dock">
          <select class="lang" aria-label="Language"></select>
          <button class="icon mic" title="Tap to talk">🎤</button>
          <button class="icon type" title="Type instead (⇧A)">⌨</button>
          <button class="icon speak" title="Professor speaks answers">🔊</button>
          <button class="prepare" title="Prepare this course">🛠 Prepare course</button>
          <button class="start" title="Hands-free"><span class="ic">✋</span><span class="tx"> Raise Your Hand</span></button>
        </div>
      </div>`;

    const layer = root.querySelector(".layer");
    const q = (s) => root.querySelector(s);
    const said = q(".said"), answerEl = q(".answer"), textEl = q(".text"), metaEl = q(".meta"),
          fbEl = q(".fb"), followEl = q(".followup"), errEl = q(".err"), statusEl = q(".statusline"),
          startBtn = q(".start"), langSel = q(".lang"), typeInput = q(".typeline input");
    let answerId = null, errTimer = null, dockTimer = null;

    // reveal the dock on any pointer movement (the overlay itself is click-through)
    document.addEventListener("mousemove", () => {
      layer.classList.add("hot"); clearTimeout(dockTimer);
      dockTimer = setTimeout(() => layer.classList.remove("hot"), 2200);
    });
    layer.classList.add("hot"); // brief reveal on load so the dock is discoverable
    setTimeout(() => layer.classList.remove("hot"), 4000);

    startBtn.onclick = () => h.onToggleHandRaise?.();
    q(".prepare").onclick = () => h.onPrepare?.();
    q(".mic").onclick = () => h.onTapToTalk?.();
    q(".type").onclick = () => api.toggleType();
    langSel.onchange = () => h.onLang?.(langSel.value);
    q(".speak").onclick = () => h.onToggleSpeak?.();
    q(".stopspk").onclick = () => h.onStop?.();
    // While the type box is open, hide every keystroke from YouTube — its hotkeys
    // (space, k, f, digits, arrows) fire on document/window and never see our shadow
    // input, so they'd act on the video. A window-capture listener runs before
    // YouTube's; stopPropagation keeps the key from them, while the input's own text
    // entry (a default action, not a listener) still happens normally.
    const keyGuard = (e) => {
      if (!layer.classList.contains("typing")) return;
      e.stopPropagation();
      if (e.type !== "keydown") return;
      if (e.key === "Enter" && typeInput.value.trim()) { e.preventDefault(); h.onType?.(typeInput.value.trim()); typeInput.value = ""; api.toggleType(false); }
      else if (e.key === "Escape") { e.preventDefault(); api.toggleType(false); }
    };
    ["keydown", "keyup", "keypress"].forEach((t) => window.addEventListener(t, keyGuard, true));
    fbEl.querySelectorAll("button").forEach((b) => b.onclick = () => {
      if (fbEl.dataset.done) return; fbEl.dataset.done = "1"; b.classList.add("picked");
      h.onFeedback?.(Number(b.dataset.r), answerId);
    });

    const TS = /\b(\d{1,2}:\d{2}(?::\d{2})?)\b/g;
    const api = {
      mountLangs(langs, current) {
        langSel.innerHTML = langs.map((l) => `<option value="${l.code}">${l.label}</option>`).join("");
        langSel.value = current;
      },
      setLang(code) { langSel.value = code; },
      setState(s) { layer.classList.remove("err"); layer.dataset.state = s; if (s === "idle") layer.classList.remove("typing"); },
      setTranscript(t) { said.textContent = t ? "“" + t + "”" : ""; },
      beginAnswer() {
        textEl.textContent = ""; metaEl.textContent = ""; answerEl.classList.remove("done");
        fbEl.dataset.done = ""; fbEl.querySelectorAll(".picked").forEach((b) => b.classList.remove("picked"));
        q(".fmore").innerHTML = ""; // drop any follow-up buttons from the previous answer
        layer.dataset.state = "answer";
      },
      appendAnswer(delta) { if (layer.dataset.state !== "answer") this.beginAnswer(); textEl.textContent += delta; }, // stay at the top so the reader starts at the beginning
      finishAnswer({ id, meta } = {}) {
        answerId = id || null;
        const raw = textEl.textContent; textEl.innerHTML = "";
        let last = 0, m; TS.lastIndex = 0;
        while ((m = TS.exec(raw))) {
          if (m.index > last) textEl.append(raw.slice(last, m.index));
          const a = document.createElement("span"); a.className = "ts"; a.textContent = m[1];
          a.onclick = () => h.onSeek?.(m[1].split(":").map(Number).reduce((x, n) => x * 60 + n, 0));
          textEl.append(a); last = m.index + m[1].length;
        }
        if (last < raw.length) textEl.append(raw.slice(last));
        if (meta) metaEl.textContent = meta;
        answerEl.classList.add("done");
        textEl.scrollTop = 0; // show the start of the answer for reading
      },
      // Voice mode: a pill with the prompt + a listening indicator + manual buttons
      // (so the learner can click if the "yes/no" mishears).
      showFollowup({ text, listening, askLabel, resumeLabel }) {
        const mini = listening ? `<span class="mini"><i></i><i></i><i></i></span>` : "";
        followEl.innerHTML = `<span class="fq">${text}</span>${mini}<button class="fask">${askLabel}</button><button class="fresume">${resumeLabel}</button>`;
        followEl.querySelector(".fask").onclick = () => h.onFollowAsk?.();
        followEl.querySelector(".fresume").onclick = () => h.onFollowResume?.();
        layer.dataset.state = "followup";
      },
      // Silent mode: keep the answer on screen; add buttons to its footer.
      showAnswerFollowup({ askLabel, resumeLabel }) {
        const el = q(".fmore");
        el.innerHTML = `<button class="fask">${askLabel}</button><button class="fresume">${resumeLabel}</button>`;
        el.querySelector(".fask").onclick = () => h.onFollowAsk?.();
        el.querySelector(".fresume").onclick = () => h.onFollowResume?.();
      },
      showError(msg) { errEl.textContent = msg; layer.classList.remove("status"); layer.classList.add("err"); clearTimeout(errTimer); errTimer = setTimeout(() => layer.classList.remove("err"), 5000); },
      showStatus(text) { statusEl.textContent = text; layer.classList.add("status"); },
      clearStatus() { layer.classList.remove("status"); },
      setHandRaise(on) { startBtn.classList.toggle("on", on); layer.classList.toggle("armed", on); startBtn.querySelector(".ic").textContent = on ? "◼" : "✋"; startBtn.querySelector(".tx").textContent = on ? " Stop" : " Raise Your Hand"; },
      setReady(kind) { layer.classList.toggle("ready", kind === "ready"); layer.classList.toggle("can-prepare", kind === "prepare"); },
      setListeningUI(on) { layer.classList.toggle("live", on); },
      setSpeaking(on) { layer.classList.toggle("speaking", on); },
      setSpeak(on) { const b = q(".speak"); if (!b) return; b.textContent = on ? "🔊" : "🔇"; b.classList.toggle("off", !on); b.title = on ? "Professor speaks (on — click to mute)" : "Professor speaks (off — click to enable)"; },
      toggleType(force) {
        const show = force === undefined ? !layer.classList.contains("typing") : force;
        layer.classList.toggle("typing", show);
        if (show) typeInput.focus(); else typeInput.blur();
      },
    };
    return api;
  }

  function mountView() {
    const host = document.createElement("div");
    host.id = "ryh-root";
    Object.assign(host.style, { position: "fixed", inset: "0", zIndex: "2147483000", pointerEvents: "none" });
    document.documentElement.append(host);
    view = createView(host, {
      onToggleHandRaise: toggleHandRaise,
      onTapToTalk: () => startTurn(),
      onLang: (code) => { sttLang = code; try { chrome.storage && chrome.storage.local && chrome.storage.local.set({ ryhLang: code }); } catch (_) {} },
      onType: (text) => { active = true; voiceTurn = false; const v = video(); if (v && !v.paused) v.pause(); maybeResetSession(); ask(text); },
      onSeek: (s) => { const v = video(); if (v) { v.currentTime = s; v.play(); } endTurn(); },
      onFeedback: (rating, id) => { if (!id) return; fetch(`${BACKEND}/feedback`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answerId: id, rating, deviceId }) }).catch(() => {}); },
      onPrepare: prepareCourse,
      onFollowAsk: () => { // ask another — re-listen (voice) or open the type box
        followUpMode = false; stopSpeaking();
        if (voiceTurn) { if (!listening) toggleDictation(); }
        else if (view) view.toggleType(true);
      },
      onFollowResume: () => { // stop everything and play on
        followUpMode = false; stopSpeaking();
        if (listening) { ignoreDictation = true; stopDictation(); }
        resumeVideo();
      },
      onStop: () => { stopSpeaking(); askFollowUp(false); }, // cut the spoken answer short, go to the follow-up
      onToggleSpeak: () => {
        speakAnswers = !speakAnswers;
        if (!speakAnswers) stopSpeaking();
        if (view) view.setSpeak(speakAnswers);
        try { chrome.storage && chrome.storage.local && chrome.storage.local.set({ ryhSpeak: speakAnswers }); } catch (_) {}
      },
    });
    view.mountLangs(LANGS.map((l) => ({ code: l.code, label: l.label })), sttLang);
    view.setSpeak(speakAnswers);
  }

  function refreshReady() {
    if (!view) return;
    const ready = course && course.ingested && lectureForVideo(getVideoId());
    if (ready) view.setReady("ready");
    else if (course && !course.ingested && getPlaylistId() && !preparing) view.setReady("prepare");
    else view.setReady("none");
    view.setHandRaise(handRaiseOn);
  }

  function maybeResetSession() {
    const vid = getVideoId();
    const t = video() ? video().currentTime : 0;
    if (vid !== anchor.videoId || Math.abs(t - anchor.time) > HISTORY_RESET_GAP) {
      history = [];
      anchor = { videoId: vid, time: t };
      sessionId = genId("ses");
      sessionFrame = null; // new pause point → grab a fresh screenshot next time
    }
  }

  // Start a Q&A turn (from a raised hand or a mic tap): pause, grab the frame,
  // enter the listening state, and start capturing voice.
  async function startTurn() {
    if (listening) { stopDictation(); return; } // tapping again stops + sends
    suspendDetection(); // one turn at a time — ignore further raises until it ends
    active = true;
    const v = video();
    if (v && !v.paused) v.pause();
    maybeResetSession();
    sessionFrame = await captureFrame(); // clean frame before anything covers the video
    view.setState("listening");
    view.setTranscript("");
    toggleDictation();
  }

  // End a turn: stop speech, re-arm the detector, hide the overlay.
  function endTurn() {
    active = false;
    followUpMode = false;
    stopSpeaking();
    resumeDetection();
    if (view) view.setState("idle");
  }

  // Error path: surface the message, drop back to idle, re-arm — but leave the
  // video paused so the learner can just try again.
  function abortTurn(msg) {
    if (view) { view.showError(msg); view.setState("idle"); }
    active = false;
    followUpMode = false;
    stopSpeaking();
    resumeDetection();
  }

  // ---- voice input ----
  // Prefer the local Whisper server (record → transcribe; far better non-English
  // accuracy); fall back to the browser's Web Speech API if it isn't running.
  function toggleDictation() {
    if (listening) { stopDictation(); return; }
    fetch(`${STT_BACKEND}/health`, { method: "GET" })
      .then((r) => (r.ok ? startWhisper() : startWebSpeech()))
      .catch(() => startWebSpeech());
  }

  function setListeningUI(on) {
    listening = on;
    if (view) { view.setListeningUI(on); if (on) { view.setState("listening"); view.setTranscript(""); } }
  }

  // Shared post-transcription handling for both engines.
  function finishDictation(raw) {
    if (ignoreDictation) { ignoreDictation = false; return; } // cancelled by a button
    const text = (raw || "").trim();
    if (followUpMode) {
      followUpMode = false;
      if (isNoMore(text)) return resumeVideo(); // done → play on
    } else if (!text) {
      return endTurn(); // said nothing → quietly resume
    }
    if (view) { view.setTranscript(text); view.setState("thinking"); }
    voiceTurn = true; // came in by voice → follow up by voice
    ask(text);
  }

  function stopAudio() {
    if (vadTimer) { clearInterval(vadTimer); clearTimeout(vadTimer); vadTimer = null; }
    try { if (audioCtx) { audioCtx.close(); audioCtx = null; } } catch (_) {}
    try { if (audioStream) { audioStream.getTracks().forEach((t) => t.stop()); audioStream = null; } } catch (_) {}
    mediaRecorder = null;
  }

  // Volume-based voice-activity detection: auto-send after a pause once the
  // person has spoken; give up if they never speak (follow-up mode then resumes).
  function startVAD(stream, onStop) {
    speechDetected = false;
    const fire = () => { if (vadTimer) { clearInterval(vadTimer); vadTimer = null; } onStop(); };
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      audioCtx.resume && audioCtx.resume();
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 512;
      audioCtx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      const start = Date.now();
      let lastLoud = start;
      vadTimer = setInterval(() => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) { const d = v - 128; sum += d * d; }
        const rms = Math.sqrt(sum / buf.length);
        const now = Date.now();
        if (rms > 7) { speechDetected = true; lastLoud = now; }
        if (speechDetected && now - lastLoud > 1300) return fire();  // paused after speaking → send
        if (!speechDetected && now - start > 7000) return fire();    // never spoke → give up
        if (now - start > 30000) return fire();                      // hard cap
      }, 120);
    } catch (_) {
      vadTimer = setTimeout(fire, 15000); // no analyser → rely on ⏹ + a max timer
    }
  }

  async function startWhisper() {
    try {
      audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (_) {
      return abortTurn("Microphone permission denied — allow it and try again.");
    }
    const chunks = [];
    let mr;
    try { mr = new MediaRecorder(audioStream, { mimeType: "audio/webm" }); }
    catch (_) { mr = new MediaRecorder(audioStream); }
    mediaRecorder = mr;
    mr.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    mr.onstop = () => {
      const blob = new Blob(chunks, { type: mr.mimeType || "audio/webm" });
      stopAudio();
      setListeningUI(false);
      if (blob.size < 1200) return finishDictation(""); // essentially no audio → silence
      if (view) view.setState("thinking");
      const lang = (sttLang || "en").slice(0, 2); // pt-BR → pt
      fetch(`${STT_BACKEND}/stt?lang=${lang}`, { method: "POST", body: blob })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error("stt"))))
        .then((j) => finishDictation(j.text || ""))
        .catch(() => {
          if (followUpMode) finishDictation("");
          else abortTurn("Couldn't transcribe — is stt/server.py running?");
        });
    };
    setListeningUI(true);
    startVAD(audioStream, () => { try { if (mr.state !== "inactive") mr.stop(); } catch (_) {} });
    try { mr.start(); } catch (_) {}
  }

  // Browser Web Speech fallback (Google's recognizer; weaker for non-English).
  function startWebSpeech() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return abortTurn("Voice input needs the Whisper server (stt/server.py) or a browser that supports speech input.");
    finalTranscript = "";
    const rec = new SR();
    recognition = rec;
    rec.lang = sttLang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.onstart = () => {
      setListeningUI(true);
      if (followUpMode) { clearTimeout(silenceTimer); silenceTimer = setTimeout(() => { try { rec.stop(); } catch (_) {} }, 7000); }
    };
    rec.onerror = (e) => {
      if (view) view.showError(e.error === "not-allowed" ? "Microphone permission denied — allow it and try again." : `Voice error: ${e.error}`);
    };
    rec.onend = () => {
      setListeningUI(false);
      recognition = null;
      clearTimeout(silenceTimer);
      finishDictation(finalTranscript);
    };
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalTranscript += r[0].transcript + " ";
        else interim += r[0].transcript;
      }
      if (view) view.setTranscript((finalTranscript + interim).trim()); // live echo
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => { try { rec.stop(); } catch (_) {} }, 3000);
    };
    try { rec.start(); } catch (_) {}
  }

  function stopDictation() {
    clearTimeout(silenceTimer);
    try { recognition && recognition.stop(); } catch (_) {}                          // Web Speech → onend
    try { mediaRecorder && mediaRecorder.state !== "inactive" && mediaRecorder.stop(); } catch (_) {} // Whisper → onstop
  }

  // ---- hands-free: raise your hand (webcam) to start asking ----
  // The webcam + MediaPipe detection run in an offscreen document (offscreen.js);
  // here we start/stop it via the service worker and react to its messages.
  function toggleHandRaise() {
    if (handRaiseOn) { stopHandRaise(); return; }
    if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
      return view && view.showError("Hand-raise needs the installed extension (not injection).");
    }
    handRaiseOn = true;
    refreshReady();
    if (view) view.showStatus("Starting camera…");
    chrome.runtime.sendMessage({ type: "ryh-gesture-start" }, (r) => {
      const err = (chrome.runtime.lastError && chrome.runtime.lastError.message) || (r && r.error);
      if (err) { if (view) view.showError(`Couldn't start: ${err}`); stopHandRaise(); }
      // "ready" / camera errors / hand-raises arrive as messages (handled below).
    });
  }

  function stopHandRaise() {
    handRaiseOn = false;
    turnActive = false;
    try { chrome.runtime && chrome.runtime.sendMessage({ type: "ryh-gesture-stop" }); } catch (_) {}
    if (view) view.clearStatus();
    refreshReady();
  }

  // Pause the webcam detection loop while a question is being asked/answered, so
  // hand movements during the turn don't fire another trigger.
  function suspendDetection() {
    if (turnActive) return;
    turnActive = true;
    try { chrome.runtime && chrome.runtime.sendMessage({ type: "ryh-gesture-suspend", on: true }); } catch (_) {}
  }
  function resumeDetection() {
    if (!turnActive) return;
    turnActive = false;
    try { chrome.runtime && chrome.runtime.sendMessage({ type: "ryh-gesture-suspend", on: false }); } catch (_) {}
  }

  // Gesture messages relayed from the offscreen detector via the service worker.
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || !handRaiseOn) return;
      if (msg.type === "ryh-gesture-ready") {
        if (view) view.clearStatus(); // the idle cue is now the indicator
      } else if (msg.type === "ryh-handraise") {
        if (turnActive) return; // suspended mid-turn — ignore stray triggers
        startTurn();
      } else if (msg.type === "ryh-gesture-error") {
        if (view) view.showError(`Camera/tracking error: ${msg.message}`);
        stopHandRaise();
      } else if (msg.type === "ryh-gesture-debug") {
        console.log("[ryh]", msg.info); // detector diagnostics, visible in the page console (F12)
      }
    });
  }

  // ---- speech out (Kokoro, streamed; browser speechSynthesis fallback) ----
  let speechToken = 0;
  function chunkForSpeech(text) {
    const clean = String(text).replace(/\s+/g, " ").trim();
    if (!clean) return [];
    const MAX = 130;
    const out = [];
    let cur = "";
    const flush = () => { if (cur) { out.push(cur); cur = ""; } };
    const add = (s) => {
      if (cur && cur.length + s.length + 1 > MAX) flush();
      cur = cur ? cur + " " + s : s;
    };
    const sentences = clean.match(/[^.!?]+[.!?]*/g) || [clean];
    for (const part of sentences) {
      let s = part.trim();
      if (!s) continue;
      while (s.length > MAX) {
        flush();
        let cut = s.lastIndexOf(" ", MAX);
        if (cut <= 0) cut = MAX;
        out.push(s.slice(0, cut).trim());
        s = s.slice(cut).trim();
      }
      if (s) add(s);
    }
    flush();
    return out;
  }
  let currentAudio = null;
  function speak(text, onEnd) {
    stopSpeaking(); // stop anything in-flight and bump the token
    const clean = String(text)
      .replace(/[*`]/g, "")
      .replace(/\p{Extended_Pictographic}/gu, "")
      .replace(/\s+/g, " ").trim();
    if (!clean) { if (onEnd) onEnd(); return; }
    const myToken = speechToken;
    let ended = false;
    const end = () => { if (!ended && myToken === speechToken) { ended = true; if (onEnd) onEnd(); } };
    const { voice, ttsLang } = langEntry();
    const chunks = chunkForSpeech(clean);
    if (!chunks.length) { end(); return; }

    const fetchChunk = (i) => {
      if (i >= chunks.length) return Promise.resolve(null);
      return fetch(`${TTS_BACKEND}/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: chunks[i], voice, lang: ttsLang }),
      }).then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`tts ${r.status}`)))).catch(() => "ERR");
    };

    let pending = fetchChunk(0); // prefetch the first sentence
    const playFrom = (i) => {
      if (myToken !== speechToken) return; // superseded by stop/new speak
      if (i >= chunks.length) { end(); return; }
      const blobP = pending;
      pending = fetchChunk(i + 1); // prefetch next while this one plays
      blobP.then((blob) => {
        if (myToken !== speechToken) return;
        if (blob === "ERR" || !blob) { speakBrowser(chunks.slice(i).join(" "), end); return; }
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        currentAudio = audio;
        const step = () => { URL.revokeObjectURL(url); if (currentAudio === audio) currentAudio = null; playFrom(i + 1); };
        audio.onended = step;
        audio.onerror = step;
        audio.play().catch(() => {
          audio.onended = audio.onerror = null;
          URL.revokeObjectURL(url);
          if (myToken === speechToken) speakBrowser(chunks.slice(i).join(" "), end);
        });
      });
    };
    playFrom(0);
  }

  function speakBrowser(text, onEnd) {
    try { window.speechSynthesis && speechSynthesis.cancel(); } catch (_) {}
    if (!window.speechSynthesis) { if (onEnd) onEnd(); return; }
    const chunks = chunkForSpeech(text);
    if (!chunks.length) { if (onEnd) onEnd(); return; }
    const myToken = speechToken;
    let i = 0;
    const next = () => {
      if (myToken !== speechToken) return;
      if (i >= chunks.length) { if (onEnd) onEnd(); return; }
      const chunk = chunks[i++];
      let advanced = false;
      const advance = () => { if (!advanced) { advanced = true; next(); } };
      try {
        const u = new SpeechSynthesisUtterance(chunk);
        u.lang = navigator.language || "en-US";
        u.onend = advance;
        u.onerror = advance;
        setTimeout(advance, Math.min(16000, 3000 + chunk.length * 130));
        speechSynthesis.speak(u);
      } catch (_) { advance(); }
    };
    next();
  }
  function stopSpeaking() {
    speechToken++;
    try { if (currentAudio) { currentAudio.pause(); currentAudio = null; } } catch (_) {}
    try { window.speechSynthesis && speechSynthesis.cancel(); } catch (_) {}
    if (view) view.setSpeaking(false);
  }

  // ---- streaming speech: speak sentences as they arrive from the LLM, so the
  // answer starts playing after the FIRST sentence instead of the whole reply.
  // The next sentence is synthesized one ahead (prefetch) so playback is gapless
  // — otherwise there's an audible pause at each "." while the next clip renders. ----
  let speechQueue = [];
  let speechBusy = false;
  let speechStreamDone = false;
  let speechOnEnd = null;
  let speechEndFired = false;
  let speechNext = null; // prefetched Promise<blobUrl|null> for the head of the queue
  const sentenceCut = (s) => { const m = /[.!?]+\s/.exec(s); return m ? m.index + m[0].length : -1; };

  // Synthesize one sentence → object URL (null if the turn was superseded).
  function ttsFetch(sentence, token) {
    const { voice, ttsLang } = langEntry();
    return fetch(`${TTS_BACKEND}/tts`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: sentence, voice, lang: ttsLang }) })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error("tts"))))
      .then((blob) => (token === speechToken ? URL.createObjectURL(blob) : null));
  }

  function speechStart(onEnd) {
    stopSpeaking();                 // bumps speechToken, stops any current audio
    speechQueue = [];
    speechBusy = false;
    speechStreamDone = false;
    speechEndFired = false;
    speechNext = null;
    speechOnEnd = onEnd || null;
    return speechToken;
  }
  function speechPush(text, token) {
    if (token !== speechToken) return;
    const clean = String(text).replace(/[*`]/g, "").replace(/\p{Extended_Pictographic}/gu, "").replace(/\s+/g, " ").trim();
    if (clean) speechQueue.push(clean);
    speechPump(token);
  }
  function speechEnd(token) {
    if (token !== speechToken) return;
    speechStreamDone = true;
    speechPump(token);
  }
  function speechPump(token) {
    if (token !== speechToken || speechBusy) return;
    if (speechQueue.length === 0) {
      if (speechStreamDone && !speechEndFired) { speechEndFired = true; const cb = speechOnEnd; speechOnEnd = null; if (cb) cb(); }
      return;
    }
    speechBusy = true;
    const sentence = speechQueue.shift();
    const urlPromise = speechNext || ttsFetch(sentence, token);
    speechNext = null;
    // Kick off the next sentence's synthesis NOW so it's ready the moment this ends.
    if (speechQueue.length > 0) speechNext = ttsFetch(speechQueue[0], token);
    const advance = () => { if (token !== speechToken) return; speechBusy = false; speechPump(token); };
    urlPromise
      .then((url) => {
        if (token !== speechToken) return;
        if (!url) return advance();
        const audio = new Audio(url);
        currentAudio = audio;
        const step = () => { URL.revokeObjectURL(url); if (currentAudio === audio) currentAudio = null; advance(); };
        audio.onended = step;
        audio.onerror = step;
        audio.play().catch(() => { audio.onended = audio.onerror = null; URL.revokeObjectURL(url); advance(); });
      })
      .catch(() => { if (token === speechToken) speakBrowser(sentence, advance); else advance(); }); // TTS down → browser voice
  }

  // ---- follow-up loop ----
  function isNoMore(text) {
    const t = text.trim();
    if (!t) return true;
    if (/^(no|n[ãa]o|nope|nah)[.!\s]*$/i.test(t)) return true; // STT often mis-hears "não" as "no"
    return LANGS.some((l) => l.noMore.test(t)); // accept any language's negative — STT can drift
  }
  function askFollowUp(speakPrompt = true) {
    if (!active) return; // turn already ended — don't nag
    if (view) view.setSpeaking(false);
    const L = langEntry();
    if (voiceTurn && speakAnswers) {
      // Voice question + speaking: pill + buttons + speak the prompt, then listen.
      if (view) view.showFollowup({ text: L.followUp, listening: true, askLabel: L.askMore, resumeLabel: L.resume });
      followUpMode = true;
      if (speakPrompt) speak(L.followUp, () => { if (followUpMode && !listening) toggleDictation(); });
      else if (!listening) toggleDictation(); // came from Stop — skip re-speaking, go straight to listening
    } else {
      // Typed question (or muted): keep the answer visible, offer buttons — never open the mic.
      if (view) view.showAnswerFollowup({ askLabel: L.askMore, resumeLabel: L.resume });
    }
  }
  function resumeVideo() {
    const v = video();
    if (v && v.paused) v.play();
    endTurn();
  }

  // ---- visual questions: ask the background worker to capture the tab frame ----
  function captureFrame() {
    return new Promise((resolve) => {
      try {
        if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) return resolve(null);
        chrome.runtime.sendMessage({ type: "ryh-capture" }, (r) => {
          if (chrome.runtime.lastError || !r || !r.dataUrl) return resolve(null);
          const m = /^data:(.+?);base64,(.*)$/.exec(r.dataUrl);
          resolve(m ? { mediaType: m[1], base64: m[2] } : null);
        });
      } catch (_) { resolve(null); }
    });
  }

  // ---- ask flow ----
  async function ask(question) {
    const q = (question || "").trim();
    if (!q || busy) return;
    const lec = lectureForVideo(getVideoId());
    if (!course || !course.ingested || !lec) {
      return view && view.showError("This course isn't prepared yet — open a course playlist and prepare it first.");
    }
    busy = true;
    active = true;
    const speakThis = speakAnswers;
    let speakToken = 0, speakBuf = "";
    if (speakThis) { speakToken = speechStart(askFollowUp); if (view) view.setSpeaking(true); } // speak sentences as they arrive
    else stopSpeaking();
    if (view) view.setState("thinking");
    const turnIndex = history.length; // 0 = first in this pause session
    const currentTimeSeconds = video() ? video().currentTime : 0;

    // Give the agent what's on screen on the FIRST question of the session only.
    let image = null;
    if (turnIndex === 0) {
      if (!sessionFrame) sessionFrame = await captureFrame();
      image = sessionFrame;
    }

    let answer = "";
    let answerId = null;
    try {
      const res = await fetch(`${BACKEND}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          playlistId: getPlaylistId(),
          videoId: getVideoId(),
          currentTimeSeconds,
          question: q,
          history,
          deviceId,
          sessionId,
          turnIndex,
          image: image || undefined,
          answerLanguage: langEntry().name, // force the reply into the chosen language
        }),
      });
      if (!res.ok || !res.body) throw new Error(`backend HTTP ${res.status}`);

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.type === "delta") {
            answer += ev.text;
            if (view) view.appendAnswer(ev.text);
            if (speakThis) { // hand each finished sentence to the speech queue immediately
              speakBuf += ev.text;
              let cut;
              while ((cut = sentenceCut(speakBuf)) !== -1) {
                const s = speakBuf.slice(0, cut).trim();
                speakBuf = speakBuf.slice(cut);
                if (s) speechPush(s, speakToken);
              }
            }
          } else if (ev.type === "error") {
            if (view) view.showError(ev.code === "not_ingested" ? "This course hasn't been prepared yet." : ev.message);
            if (speakThis) stopSpeaking(); // halt any sentences already queued
          } else if (ev.type === "done") {
            answerId = ev.answerId;
            if (view) view.finishAnswer({ id: answerId, meta: `Lecture ${lec.index} · ${fmt(currentTimeSeconds)}` });
            // Spoken: flush the last partial sentence; askFollowUp fires when the queue drains.
            // Silent: show the follow-up (buttons) immediately.
            if (speakThis) { if (speakBuf.trim()) speechPush(speakBuf.trim(), speakToken); speechEnd(speakToken); }
            else askFollowUp();
          }
        }
      }
    } catch (err) {
      if (view) view.showError(`Couldn't reach the backend — is it running on ${BACKEND}?`);
    } finally {
      if (answer) history.push({ question: q, answer });
      busy = false;
    }
  }

  // ---- in-page course preparation (residential IP; datacenter IPs get blocked) ----
  function extractInlineJson(html, marker) {
    const at = html.indexOf(marker);
    if (at < 0) return null;
    const start = html.indexOf("{", at);
    if (start < 0) return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < html.length; i++) {
      const c = html[i];
      if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; }
      else if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") { if (--depth === 0) return JSON.parse(html.slice(start, i + 1)); }
    }
    return null;
  }

  async function fetchPlaylistVideos(list) {
    const html = await (await fetch(`/playlist?list=${encodeURIComponent(list)}&hl=en`)).text();
    const data = extractInlineJson(html, "ytInitialData = ");
    const title = data?.metadata?.playlistMetadataRenderer?.title || list;
    let items = [];
    for (const tab of data?.contents?.twoColumnBrowseResultsRenderer?.tabs ?? []) {
      for (const sec of tab?.tabRenderer?.content?.sectionListRenderer?.contents ?? []) {
        const c = sec?.itemSectionRenderer?.contents;
        if (Array.isArray(c) && c.length > items.length) items = c;
      }
    }
    const videos = [];
    let truncated = false;
    for (const it of items) {
      if (it?.continuationItemRenderer) { truncated = true; continue; }
      const l = it?.lockupViewModel;
      if (l?.contentId && l?.contentType === "LOCKUP_CONTENT_TYPE_VIDEO") {
        videos.push({ videoId: l.contentId, title: l.metadata?.lockupMetadataViewModel?.title?.content || l.contentId });
      }
    }
    return { title, videos, truncated };
  }

  function decodeEntities(t) {
    return t.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
  }
  function parseTimedText(body) {
    const segments = [];
    if (body.trimStart().startsWith("{")) {
      const json = JSON.parse(body);
      for (const ev of json.events ?? []) {
        const text = (ev.segs ?? []).map((s) => s.utf8 ?? "").join("").replace(/\s+/g, " ").trim();
        if (text) segments.push({ start: Math.round((ev.tStartMs ?? 0) / 1000), text });
      }
    } else {
      for (const m of body.matchAll(/<p t="(\d+)"[^>]*>([\s\S]*?)<\/p>/g)) {
        const text = decodeEntities(m[2].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
        if (text) segments.push({ start: Math.round(Number(m[1]) / 1000), text });
      }
    }
    return segments;
  }

  async function fetchTranscript(videoId) {
    const r = await fetch("/youtubei/v1/player?prettyPrint=false", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        context: { client: { clientName: "ANDROID", clientVersion: "20.10.38", androidSdkVersion: 30, hl: "en" } },
        videoId,
      }),
    });
    const j = await r.json();
    if (j?.playabilityStatus?.status !== "OK") throw new Error(`not playable (${j?.playabilityStatus?.status})`);
    const d = j.videoDetails || {};
    const tracks = j?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    if (!tracks.length) throw new Error("no captions");
    const score = (t) => (t.kind === "asr" ? 0 : 2) + (String(t.languageCode || "").startsWith("en") ? 1 : 0);
    const track = [...tracks].sort((a, b) => score(b) - score(a))[0];
    const u = new URL(track.baseUrl);
    u.searchParams.set("fmt", "json3");
    const segments = parseTimedText(await (await fetch(u.toString())).text());
    if (!segments.length) throw new Error("empty transcript");
    return {
      videoId,
      title: d.title || videoId,
      description: d.shortDescription || "",
      durationSeconds: Number(d.lengthSeconds || 0),
      captionKind: track.kind === "asr" ? "asr" : "manual",
      captionLanguage: String(track.languageCode || "unknown"),
      segments,
    };
  }

  async function prepareCourse() {
    if (preparing) return;
    const list = getPlaylistId();
    if (!list) return;
    preparing = true;
    refreshReady();
    try {
      view.showStatus("Reading the playlist…");
      const pl = await fetchPlaylistVideos(list);
      if (!pl.videos.length) return view.showError("No videos found in this playlist.");
      if (pl.videos.length > 40) return view.showError(`This playlist has ${pl.videos.length} videos; the MVP caps at 40.`);

      const videos = [];
      for (let i = 0; i < pl.videos.length; i++) {
        view.showStatus(`Reading transcripts… ${i + 1}/${pl.videos.length}`);
        try { videos.push(await fetchTranscript(pl.videos[i].videoId)); } catch (_) { /* skip caption-less */ }
      }
      if (!videos.length) return view.showError("No transcripts available for this course.");

      view.showStatus(`Building the course map from ${videos.length} lectures… (~1 min)`);
      const res = await fetch(`${BACKEND}/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ playlistId: list, title: pl.title, videos }),
      });
      if (!res.ok || !res.body) throw new Error(`backend HTTP ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const ev = JSON.parse(line);
          if (ev.type === "progress") view.showStatus(ev.message);
          else if (ev.type === "error") return view.showError(`Couldn't prepare: ${ev.message}`);
          else if (ev.type === "done") {
            view.clearStatus();
            preparing = false;
            await loadCourse();
            return;
          }
        }
      }
    } catch (err) {
      view.showError(`Couldn't prepare: ${err.message}`);
    } finally {
      preparing = false;
      refreshReady();
    }
  }

  async function loadCourse() {
    const pid = getPlaylistId();
    currentPlaylistId = pid;
    course = null;
    if (!pid) { refreshReady(); return; }
    try {
      const res = await fetch(`${BACKEND}/course?playlistId=${encodeURIComponent(pid)}`);
      course = await res.json();
    } catch {
      course = { ingested: false, error: "backend offline" };
    }
    refreshReady();
  }

  function onNavigate() {
    history = [];
    anchor = { videoId: getVideoId(), time: 0 };
    sessionId = genId("ses");
    if (active) endTurn();
    if (getPlaylistId() !== currentPlaylistId) loadCourse();
    else refreshReady();
  }

  // Watch-time sampling: one heartbeat per interval while a prepared course plays.
  function startHeartbeats() {
    setInterval(() => {
      const v = video();
      if (!v || v.paused || !deviceId) return;
      if (!course || !course.ingested || !lectureForVideo(getVideoId())) return;
      fetch(`${BACKEND}/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId,
          playlistId: getPlaylistId(),
          videoId: getVideoId(),
          currentTimeSeconds: v.currentTime,
          seconds: HEARTBEAT_SECONDS,
        }),
      }).catch(() => {});
    }, HEARTBEAT_SECONDS * 1000);
  }

  function init() {
    loadDeviceId();
    mountView();
    loadLang();
    loadCourse();
    startHeartbeats();
    document.addEventListener("yt-navigate-finish", onNavigate);
    document.addEventListener("keydown", (e) => {
      if (/input|textarea/i.test(e.target.tagName || "")) return;
      if (e.shiftKey && (e.key === "A" || e.key === "a")) { e.preventDefault(); view && view.toggleType(); }
      else if (e.key === "Escape" && active) { e.preventDefault(); endTurn(); }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();

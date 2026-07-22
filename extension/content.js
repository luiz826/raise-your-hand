// Raise Your Hand — content script (dev shell).
// Reads the paused YouTube player, sends the current lecture + timestamp to the
// local backend, and renders a course-aware answer with clickable timestamps.
(() => {
  "use strict";
  if (window.__ryhInjected) return;
  window.__ryhInjected = true;

  // DEPLOY: point this at the hosted backend and add the same origin to
  // host_permissions in manifest.json (see SHIP.md).
  const BACKEND = "http://localhost:8787";
  const TTS_BACKEND = "http://localhost:8788"; // local Kokoro neural-TTS server (tts/server.py)
  const STT_BACKEND = "http://localhost:8789"; // local Whisper speech-to-text server (stt/server.py)
  // Voice language: drives speech-to-text (rec.lang), the Kokoro voice + lang for
  // the spoken answer, and the follow-up prompt/"no" detection. Pick in the panel.
  const LANGS = [
    { code: "en-US", label: "EN", name: "English", ttsLang: "en-us", voice: "am_michael",
      followUp: "Any other questions?",
      ask: "Ask another question, or say “no” to keep watching.",
      resume: "Okay — resuming. ✋ Raise your hand anytime.",
      noMore: /^(no|nope|nah|no thanks?|no thank you|that'?s all|that'?s it|i'?m good|im good|i'?m done|im done|nothing|nothing else|no more|no more questions?|all good|we'?re good|stop|thanks|thank you)\.?$/i },
    { code: "pt-BR", label: "PT", name: "Brazilian Portuguese", ttsLang: "pt-br", voice: "pm_alex",
      followUp: "Tem mais alguma pergunta?",
      ask: "Faça outra pergunta, ou diga “não” para continuar assistindo.",
      resume: "Certo — voltando ao vídeo. ✋ Levante a mão quando quiser.",
      noMore: /^(n[ãa]o|nada|só isso|so isso|é isso|e isso|estou bem|tô bem|to bem|acabou|para|parar|obrigad[oa]|valeu|n[ãa]o obrigad[oa])\.?$/i },
    { code: "es-ES", label: "ES", name: "Spanish", ttsLang: "es", voice: "em_alex",
      followUp: "¿Alguna otra pregunta?",
      ask: "Haz otra pregunta, o di “no” para seguir viendo.",
      resume: "De acuerdo — reanudando. ✋ Levanta la mano cuando quieras.",
      noMore: /^(no|nada|eso es todo|estoy bien|ya está|ya esta|gracias|no gracias|para|parar)\.?$/i },
    { code: "fr-FR", label: "FR", name: "French", ttsLang: "fr-fr", voice: "ff_siwis",
      followUp: "D'autres questions ?",
      ask: "Posez une autre question, ou dites « non » pour continuer.",
      resume: "D'accord — on reprend. ✋ Levez la main quand vous voulez.",
      noMore: /^(non|rien|c'?est tout|ça va|ca va|merci|non merci|stop|arr[êe]ter?)\.?$/i },
    { code: "it-IT", label: "IT", name: "Italian", ttsLang: "it", voice: "im_nicola",
      followUp: "Altre domande?",
      ask: "Fai un'altra domanda, o dì “no” per continuare a guardare.",
      resume: "Ok — riprendo il video. ✋ Alza la mano quando vuoi.",
      noMore: /^(no|niente|tutto qui|sto bene|basta|grazie|no grazie|stop)\.?$/i },
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
  let panelOpen = false;
  let busy = false;
  let deviceId = null; // anonymous, persisted via chrome.storage.local
  let sessionId = genId("ses"); // a "pause session"; regenerated on reset

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
        chrome.storage.local.get("ryhLang", (r) => {
          sttLang = r.ryhLang || fromNav();
          if (langSel) langSel.value = sttLang;
        });
        return;
      }
    } catch (_) {}
    sttLang = fromNav();
    if (langSel) langSel.value = sttLang;
  }

  // ---- dom helpers ----
  const $ = (tag, props = {}, ...kids) => {
    const el = Object.assign(document.createElement(tag), props);
    for (const k of kids) el.append(k);
    return el;
  };

  const video = () => document.querySelector("video.html5-main-video, video");
  const params = () => new URLSearchParams(location.search);
  const getVideoId = () => params().get("v");
  const getPlaylistId = () => params().get("list");

  const fmt = (s) => {
    s = Math.max(0, Math.floor(s));
    const h = Math.floor(s / 3600),
      m = Math.floor((s % 3600) / 60),
      sec = s % 60;
    const p = (n) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`;
  };
  const parseTime = (t) =>
    t.split(":").map(Number).reduce((a, n) => a * 60 + n, 0);

  // ---- shadow UI ----
  let root, panel, header, status, thread, input, askBtn, micBtn, langSel;
  let startBtn, toastEl, toastTimer = null;
  let preparing = false;
  let listening = false;
  let speakNext = false; // speak the next answer aloud (question came in by voice)
  let followUpMode = false; // listening for a "any other questions?" reply, not a fresh question
  let turnActive = false; // a Q&A turn is in progress → suspend hand detection
  let recognition = null;
  let finalTranscript = "";
  let silenceTimer = null;
  // Whisper recording (record → transcribe); falls back to Web Speech below.
  let mediaRecorder = null, audioStream = null, audioCtx = null, vadTimer = null, speechDetected = false;
  let sessionFrame = null; // screenshot of the paused video, captured once per pause session and sent with questions
  // hands-free (webcam hand-raise)
  let handRaiseOn = false;
  let handToggle = null;

  function buildUI() {
    const host = $("div", { id: "ryh-root" });
    document.documentElement.append(host);
    root = host.attachShadow({ mode: "open" });
    root.append($("style", { textContent: STYLE }));

    // Always-visible entry point: start hands-free (camera + hand-raise) mode.
    startBtn = $("button", { className: "ryh-start", textContent: "🖐 Raise Your Hand" });
    startBtn.onclick = toggleHandRaise;
    root.append(startBtn);
    toastEl = $("div", { className: "ryh-toast" });
    root.append(toastEl);

    header = $("div", { className: "ryh-head" });
    status = $("div", { className: "ryh-status" });
    const close = $("button", { className: "ryh-x", textContent: "✕", title: "Close" });
    close.onclick = closePanel;
    thread = $("div", { className: "ryh-thread" });
    input = $("textarea", {
      className: "ryh-input",
      rows: 1,
      placeholder: "Ask about this moment…",
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        ask();
      }
      e.stopPropagation(); // keep YouTube shortcuts from firing while typing
    });
    langSel = $("select", { className: "ryh-lang", title: "Voice language (speech in and out)" });
    for (const l of LANGS) langSel.append($("option", { value: l.code, textContent: l.label }));
    langSel.value = sttLang;
    langSel.onchange = () => {
      sttLang = langSel.value;
      try { chrome.storage && chrome.storage.local && chrome.storage.local.set({ ryhLang: sttLang }); } catch (_) {}
    };
    micBtn = $("button", { className: "ryh-mic", textContent: "🎤", title: "Ask by voice" });
    micBtn.onclick = toggleDictation;
    askBtn = $("button", { className: "ryh-send", textContent: "Ask" });
    askBtn.onclick = ask;
    const inputRow = $("div", { className: "ryh-inputrow" }, input, langSel, micBtn, askBtn);

    handToggle = $("button", { className: "ryh-hand", textContent: "✋", title: "Hands-free: raise your hand to ask" });
    handToggle.onclick = toggleHandRaise;
    const topbar = $("div", { className: "ryh-topbar" },
      $("div", { className: "ryh-brand" }, "🖐 Raise Your Hand"),
      $("div", { className: "ryh-topbtns" }, handToggle, close));
    panel = $("div", { className: "ryh-panel" }, topbar, header, status, thread, inputRow);
    root.append(panel);
  }

  function setStatus(text, isError) {
    if (!status) return;
    status.textContent = text || "";
    status.style.display = text ? "block" : "none";
    status.classList.toggle("err", !!isError);
  }

  // Floating message for hands-free mode — visible even when the panel is closed.
  function setToast(text, isError, sticky) {
    if (!toastEl) return;
    toastEl.textContent = text || "";
    toastEl.style.display = text ? "block" : "none";
    toastEl.classList.toggle("err", !!isError);
    clearTimeout(toastTimer);
    if (text && !sticky && !isError) toastTimer = setTimeout(() => { if (toastEl) toastEl.style.display = "none"; }, 4000);
  }

  function updateStartBtn() {
    if (!startBtn) return;
    const ready = course && course.ingested && lectureForVideo(getVideoId());
    startBtn.style.display = ready ? "inline-flex" : "none";
    startBtn.textContent = handRaiseOn ? "✋ Hand-raise on — click to stop" : "🖐 Raise Your Hand";
    startBtn.classList.toggle("on", handRaiseOn);
  }

  function setHeader() {
    header.textContent = "";
    const v = video();
    const lec = course && lectureForVideo(getVideoId());
    if (!course) {
      header.append(note("Connecting to backend…"));
    } else if (!course.ingested) {
      if (!getPlaylistId()) {
        header.append(note("Open a video that's part of a course playlist (a URL with &list=)."));
      } else if (preparing) {
        header.append(note("Preparing this course…"));
      } else {
        const btn = $("button", { className: "ryh-prepare", textContent: "🛠 Prepare this course" });
        btn.onclick = prepareCourse;
        header.append(
          note("This course isn't prepared yet. First run reads its transcripts and takes ~1 minute."),
          btn,
        );
      }
    } else if (!lec) {
      header.append(note("This video isn't part of the prepared course."));
    } else {
      header.append(
        $("span", { className: "ryh-lec" }, `Lecture ${lec.index}`),
        $("span", { className: "ryh-when" }, ` · paused at ${fmt(v ? v.currentTime : 0)}`),
      );
    }
  }

  const note = (t) => $("div", { className: "ryh-note", textContent: t });
  const lectureForVideo = (vid) =>
    course && course.lectures ? course.lectures.find((l) => l.videoId === vid) : null;

  // ---- open/close ----
  function openPanel() {
    if (!panel) return;
    const v = video();
    if (v && !v.paused) v.pause();
    maybeResetSession();
    setHeader();
    panel.classList.add("open");
    panelOpen = true;
    input.focus();
  }
  function closePanel() {
    panel.classList.remove("open");
    panelOpen = false;
    stopSpeaking();
    resumeDetection(); // the turn is over — let the webcam watch for a new raise
  }

  function maybeResetSession() {
    const vid = getVideoId();
    const t = video() ? video().currentTime : 0;
    if (vid !== anchor.videoId || Math.abs(t - anchor.time) > HISTORY_RESET_GAP) {
      history = [];
      anchor = { videoId: vid, time: t };
      sessionId = genId("ses");
      sessionFrame = null; // new pause point → grab a fresh screenshot next time
      if (thread) thread.textContent = "";
    }
  }

  // ---- voice input ----
  // Prefer the local Whisper server (record → transcribe; far better non-English
  // accuracy); fall back to the browser's Web Speech API if it isn't running.
  function toggleDictation() {
    if (listening) { stopDictation(); return; } // a second click stops and sends
    fetch(`${STT_BACKEND}/health`, { method: "GET" })
      .then((r) => (r.ok ? startWhisper() : startWebSpeech()))
      .catch(() => startWebSpeech()); // server down → browser recognizer
  }

  function setListeningUI(on) {
    listening = on;
    if (!micBtn) return;
    micBtn.classList.toggle("live", on);
    micBtn.textContent = on ? "⏹" : "🎤";
  }

  // Shared post-transcription handling for both engines.
  function finishDictation(raw) {
    const text = (raw || "").trim();
    if (followUpMode) {
      followUpMode = false;
      if (isNoMore(text)) { input.value = ""; resumeVideo(); } // done → play on
      else { input.value = text; speakNext = true; setStatus(""); ask(); } // another question
      return;
    }
    if (text) { input.value = text; speakNext = true; setStatus(""); ask(); }
    else setStatus("");
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
        if (speechDetected && now - lastLoud > 2200) return fire();  // paused after speaking → send
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
      return setStatus("Microphone permission denied — allow it and try again.", true);
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
      if (blob.size < 1200) return finishDictation(""); // essentially no audio → treat as silence
      setStatus("Transcribing…");
      const lang = (sttLang || "en").slice(0, 2); // pt-BR → pt
      fetch(`${STT_BACKEND}/stt?lang=${lang}`, { method: "POST", body: blob })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error("stt"))))
        .then((j) => finishDictation(j.text || ""))
        .catch(() => {
          if (followUpMode) finishDictation("");
          else setStatus("Couldn't transcribe — is stt/server.py running?", true);
        });
    };
    setListeningUI(true);
    setStatus(followUpMode
      ? "Listening… ask another question, or stay quiet to keep watching."
      : "Listening — take your time. Click ⏹ (or pause) to send.");
    startVAD(audioStream, () => { try { if (mr.state !== "inactive") mr.stop(); } catch (_) {} });
    try { mr.start(); } catch (_) {}
  }

  // Browser Web Speech fallback (Google's recognizer; weaker for non-English).
  function startWebSpeech() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return setStatus("Voice input needs the Whisper server (stt/server.py) or a browser that supports speech input.", true);
    finalTranscript = "";
    const rec = new SR();
    recognition = rec;
    rec.lang = sttLang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.onstart = () => {
      setListeningUI(true);
      setStatus(followUpMode
        ? "Listening… ask another question, or stay quiet to keep watching."
        : "Listening — take your time. Click ⏹ (or pause) to send.");
      if (followUpMode) { clearTimeout(silenceTimer); silenceTimer = setTimeout(() => { try { rec.stop(); } catch (_) {} }, 7000); }
    };
    rec.onerror = (e) =>
      setStatus(e.error === "not-allowed" ? "Microphone permission denied — allow it and try again." : `Voice error: ${e.error}`, true);
    rec.onend = () => {
      setListeningUI(false);
      recognition = null;
      clearTimeout(silenceTimer);
      finishDictation(finalTranscript || input.value);
    };
    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalTranscript += r[0].transcript + " ";
        else interim += r[0].transcript;
      }
      input.value = (finalTranscript + interim).trim();
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
  // The webcam + MediaPipe detection run in an offscreen document (offscreen.js),
  // because a content script's isolated world can't load MediaPipe's WASM engine.
  // Here we just start/stop it via the service worker and react to its messages.
  function toggleHandRaise() {
    if (handRaiseOn) { stopHandRaise(); return; }
    if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
      return setToast("Hand-raise needs the installed extension (not injection).", true);
    }
    handRaiseOn = true;
    if (handToggle) handToggle.classList.add("on");
    updateStartBtn();
    setToast("Starting camera…", false, true);
    console.log("[ryh] starting gesture detector…");
    chrome.runtime.sendMessage({ type: "ryh-gesture-start" }, (r) => {
      const err = (chrome.runtime.lastError && chrome.runtime.lastError.message) || (r && r.error);
      if (err) {
        console.error("[ryh] gesture-start failed:", err);
        setToast(`Couldn't start: ${err}`, true);
        stopHandRaise();
      }
      // "ready" / camera errors / hand-raises arrive as messages (handled below).
    });
  }

  function stopHandRaise() {
    handRaiseOn = false;
    turnActive = false; // detector is being torn down; clear the suspend flag
    if (handToggle) handToggle.classList.remove("on");
    try { chrome.runtime && chrome.runtime.sendMessage({ type: "ryh-gesture-stop" }); } catch (_) {}
    setToast("");
    updateStartBtn();
  }

  // Pause the webcam detection loop while a question is being asked/answered, so
  // hand movements during the turn don't fire another trigger. Resumes when the
  // turn ends (video resumes or the panel closes) and requires a fresh raise.
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

  async function onHandRaised() {
    suspendDetection(); // one turn at a time — ignore further raises until it ends
    const v = video();
    if (v && !v.paused) v.pause();
    maybeResetSession(); // start/refresh the pause session before we grab the frame
    // Screenshot the paused video BEFORE the panel opens, so our overlay isn't in the shot.
    sessionFrame = await captureFrame();
    if (!panelOpen) openPanel();
    if (!listening) toggleDictation(); // start listening; the answer is spoken back
  }

  // Gesture messages relayed from the offscreen detector via the service worker.
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || !handRaiseOn) return;
      if (msg.type === "ryh-gesture-ready") {
        console.log("[ryh] gesture detector ready");
        setToast("✋ Raise your hand to ask a question.", false, true);
      } else if (msg.type === "ryh-handraise") {
        if (turnActive) return; // suspended mid-turn — ignore stray triggers
        console.log("[ryh] hand raised");
        onHandRaised();
      } else if (msg.type === "ryh-gesture-error") {
        console.error("[ryh] gesture error:", msg.message);
        setToast(`Camera/tracking error: ${msg.message}`, true);
        stopHandRaise();
      } else if (msg.type === "ryh-gesture-debug") {
        console.log("[ryh]", msg.info); // detector diagnostics, visible in the page console (F12)
      }
    });
  }

  // A token invalidates an in-flight utterance (Kokoro audio or the browser
  // fallback queue) when speech is stopped or replaced, so onEnd fires exactly
  // once and never truncates a still-playing answer. chunkForSpeech is used only
  // by the browser fallback, where Chrome cuts off after ~15s / ~200 chars.
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
      // Hard-wrap a single over-long sentence on word boundaries so no chunk
      // exceeds the cutoff (a run-on sentence would otherwise get clipped).
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
  // Prefer the local Kokoro server for a natural voice; fall back to the
  // browser's robotic speechSynthesis if it isn't running. Streams by synthesizing
  // one sentence at a time and prefetching the next while the current plays, so
  // the first words start after ~1 sentence instead of the whole answer.
  let currentAudio = null;
  function speak(text, onEnd) {
    stopSpeaking(); // stop anything in-flight and bump the token
    // Strip markdown symbols and emojis so TTS doesn't read them aloud ("asterisk").
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
        if (blob === "ERR" || !blob) { speakBrowser(chunks.slice(i).join(" "), end); return; } // server died → browser voice
        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        currentAudio = audio;
        const step = () => { URL.revokeObjectURL(url); if (currentAudio === audio) currentAudio = null; playFrom(i + 1); };
        audio.onended = step;
        audio.onerror = step;
        audio.play().catch(() => {           // autoplay blocked / no output device
          audio.onended = audio.onerror = null;
          URL.revokeObjectURL(url);
          if (myToken === speechToken) speakBrowser(chunks.slice(i).join(" "), end);
        });
      });
    };
    playFrom(0);
  }

  // Browser speechSynthesis fallback. Chrome cuts off after ~15s / ~200 chars,
  // so speak as a queue of sentence-sized chunks (chunkForSpeech). Does NOT bump
  // speechToken — the caller (speak) already owns it.
  function speakBrowser(text, onEnd) {
    try { window.speechSynthesis && speechSynthesis.cancel(); } catch (_) {}
    if (!window.speechSynthesis) { if (onEnd) onEnd(); return; }
    const chunks = chunkForSpeech(text);
    if (!chunks.length) { if (onEnd) onEnd(); return; }
    const myToken = speechToken;
    let i = 0;
    const next = () => {
      if (myToken !== speechToken) return;        // superseded by stop/new speak
      if (i >= chunks.length) { if (onEnd) onEnd(); return; }
      const chunk = chunks[i++];
      let advanced = false;
      const advance = () => { if (!advanced) { advanced = true; next(); } };
      try {
        const u = new SpeechSynthesisUtterance(chunk);
        u.lang = navigator.language || "en-US";
        u.onend = advance;
        u.onerror = advance;
        // onend is reliable for short utterances and drives the flow; this timer
        // is a backstop for the rare miss, sized to fire only well after the
        // audio would have ended so it can never clip live speech.
        setTimeout(advance, Math.min(16000, 3000 + chunk.length * 130));
        speechSynthesis.speak(u);
      } catch (_) { advance(); }
    };
    next();
  }
  function stopSpeaking() {
    speechToken++; // invalidate any in-flight speak/queue so it can't resume
    try { if (currentAudio) { currentAudio.pause(); currentAudio = null; } } catch (_) {}
    try { window.speechSynthesis && speechSynthesis.cancel(); } catch (_) {}
  }

  // ---- follow-up loop: after a spoken answer, offer another question, and
  // resume the video when the learner is done. No LLM — a canned prompt (in the
  // chosen language) plus a simple check of what they say back.
  function isNoMore(text) {
    const t = text.trim();
    return !t || langEntry().noMore.test(t);
  }

  function askFollowUp() {
    if (!panelOpen) return; // learner closed the panel — don't nag
    const L = langEntry();
    addBubble("agent", L.followUp);
    setStatus(L.ask);
    followUpMode = true;
    // Speak the prompt, then start listening (so the mic doesn't hear the prompt).
    speak(L.followUp, () => { if (followUpMode && !listening) toggleDictation(); });
  }

  function resumeVideo() {
    followUpMode = false;
    setStatus("");
    addBubble("agent", langEntry().resume);
    const v = video();
    if (v && v.paused) v.play();
    closePanel(); // collapse so the video isn't covered; also stops any speech
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
      } catch (_) {
        resolve(null);
      }
    });
  }

  // ---- ask flow ----
  async function ask() {
    const q = input.value.trim();
    if (!q || busy) return;
    const lec = lectureForVideo(getVideoId());
    if (!course || !course.ingested || !lec) {
      setHeader();
      return;
    }
    busy = true;
    stopSpeaking();
    const speakThis = speakNext;
    speakNext = false;
    input.value = "";
    input.style.height = "auto";
    const turnIndex = history.length; // 0 = first in this pause session
    addBubble("user", q);
    const answerEl = addBubble("agent", "");
    answerEl.classList.add("streaming");
    const currentTimeSeconds = video() ? video().currentTime : 0;

    // Give the agent what's on screen on the FIRST question of the session only —
    // the paused frame is identical for follow-ups, so re-sending it just burns
    // tokens (the first answer, which saw it, is already in history).
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
            answerEl.textContent = answer;
            scrollThread();
          } else if (ev.type === "error") {
            answerEl.classList.add("error");
            answerEl.textContent =
              ev.code === "not_ingested"
                ? "This course hasn't been prepared yet."
                : `⚠ ${ev.message}`;
          } else if (ev.type === "done") {
            answerId = ev.answerId;
            answerEl.classList.remove("streaming");
            renderWithTimestamps(answerEl, answer);
            if (answerId) addFeedback(answerEl, answerId);
            // Voice turn: read the answer aloud, then offer another question
            // (which resumes the video if the learner is done).
            if (speakThis) { if (answer) speak(answer, askFollowUp); else askFollowUp(); }
          }
        }
      }
    } catch (err) {
      answerEl.classList.remove("streaming");
      answerEl.classList.add("error");
      answerEl.textContent = `⚠ Couldn't reach the backend — is it running on ${BACKEND}? (${err.message})`;
    } finally {
      answerEl.classList.remove("streaming");
      if (answer) history.push({ question: q, answer });
      busy = false;
      input.focus();
    }
  }

  function addBubble(who, text) {
    const el = $("div", { className: `ryh-msg ryh-${who}`, textContent: text });
    thread.append(el);
    scrollThread();
    return el;
  }
  const scrollThread = () => {
    thread.scrollTop = thread.scrollHeight;
  };

  // Linkify M:SS / H:MM:SS so a click seeks the current lecture's player.
  function renderWithTimestamps(el, text) {
    el.textContent = "";
    const re = /\b(\d{1,2}:\d{2}(?::\d{2})?)\b/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) el.append(text.slice(last, m.index));
      const ts = m[1];
      const link = $("button", { className: "ryh-ts", textContent: ts, title: "Jump here" });
      link.onclick = () => {
        const v = video();
        if (v) {
          v.currentTime = parseTime(ts);
          v.play();
          closePanel();
        }
      };
      el.append(link);
      last = m.index + ts.length;
    }
    if (last < text.length) el.append(text.slice(last));
  }

  // Thumbs row under an answer; one vote per answer, POSTed to /feedback.
  function addFeedback(answerEl, answerId) {
    const row = $("div", { className: "ryh-fb" });
    const up = $("button", { className: "ryh-fb-btn", textContent: "👍", title: "Helpful" });
    const down = $("button", { className: "ryh-fb-btn", textContent: "👎", title: "Not helpful" });
    const send = (rating, btn) => {
      if (row.dataset.sent) return;
      row.dataset.sent = "1";
      btn.classList.add("picked");
      up.disabled = down.disabled = true;
      fetch(`${BACKEND}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answerId, rating, deviceId }),
      }).catch(() => {});
    };
    up.onclick = () => send(1, up);
    down.onclick = () => send(-1, down);
    row.append(up, down);
    thread.append(row);
    scrollThread();
  }

  // ---- in-page course preparation (residential IP; datacenter IPs get blocked) ----

  // Balanced-brace extraction of `var X = {...};` inlined in YouTube pages.
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

  // Fetch one transcript via the InnerTube ANDROID client (works in-page; the
  // watch page's own caption URLs are proof-of-origin gated and return empty).
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
    setHeader();
    try {
      setStatus("Reading the playlist…");
      const pl = await fetchPlaylistVideos(list);
      if (!pl.videos.length) return setStatus("No videos found in this playlist.", true);
      if (pl.videos.length > 40) return setStatus(`This playlist has ${pl.videos.length} videos; the MVP caps at 40.`, true);

      const videos = [];
      for (let i = 0; i < pl.videos.length; i++) {
        setStatus(`Reading transcripts… ${i + 1}/${pl.videos.length}`);
        try { videos.push(await fetchTranscript(pl.videos[i].videoId)); } catch (_) { /* skip caption-less */ }
      }
      if (!videos.length) return setStatus("No transcripts available for this course.", true);

      setStatus(`Building the course map from ${videos.length} lectures… (~1 min)`);
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
          if (ev.type === "progress") setStatus(ev.message);
          else if (ev.type === "error") return setStatus(`Couldn't prepare: ${ev.message}`, true);
          else if (ev.type === "done") {
            setStatus("");
            preparing = false;
            await loadCourse();
            setHeader();
            return;
          }
        }
      }
    } catch (err) {
      setStatus(`Couldn't prepare: ${err.message}`, true);
    } finally {
      preparing = false;
      setHeader();
    }
  }

  async function loadCourse() {
    const pid = getPlaylistId();
    currentPlaylistId = pid;
    course = null;
    if (!pid) {
      if (panelOpen) setHeader();
      return;
    }
    try {
      const res = await fetch(`${BACKEND}/course?playlistId=${encodeURIComponent(pid)}`);
      course = await res.json();
    } catch {
      course = { ingested: false, error: "backend offline" };
    }
    if (panelOpen) setHeader();
    updateStartBtn();
  }

  function onNavigate() {
    history = [];
    anchor = { videoId: getVideoId(), time: 0 };
    sessionId = genId("ses");
    if (thread) thread.textContent = "";
    if (getPlaylistId() !== currentPlaylistId) loadCourse();
    else if (panelOpen) setHeader();
    updateStartBtn();
  }

  // Watch-time sampling: one heartbeat per interval while a prepared course is
  // actually playing. Lets stats compute questions-per-time-watched.
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
    buildUI();
    loadLang();
    loadCourse();
    startHeartbeats();
    // YouTube is a SPA — re-wire on its navigation event.
    document.addEventListener("yt-navigate-finish", onNavigate);
    // Global hotkey: Shift+A toggles the panel.
    document.addEventListener("keydown", (e) => {
      if (e.shiftKey && (e.key === "A" || e.key === "a") &&
          !/input|textarea/i.test(e.target.tagName || "")) {
        e.preventDefault();
        panelOpen ? closePanel() : openPanel();
      }
    });
  }

  const STYLE = `
:host { all: initial; }
* { box-sizing: border-box; font-family: -apple-system, "Segoe UI", Roboto, sans-serif; }
.ryh-start { position: fixed; right: 24px; bottom: 24px; display: none; align-items: center; gap: 7px;
  padding: 11px 18px; border: none; border-radius: 999px; cursor: pointer; background: #1f6feb; color: #fff;
  font-size: 14px; font-weight: 700; box-shadow: 0 4px 18px rgba(0,0,0,.4); }
.ryh-start:hover { background: #2b7cff; }
.ryh-start.on { background: #b62324; }
.ryh-start.on:hover { background: #d12c2d; }
.ryh-toast { position: fixed; right: 24px; bottom: 74px; display: none; max-width: 280px; padding: 9px 14px;
  border-radius: 10px; background: #0f1216; color: #e8eaed; border: 1px solid #2a2f37; font-size: 13px;
  box-shadow: 0 6px 20px rgba(0,0,0,.45); }
.ryh-toast.err { color: #ff7b72; border-color: #5a2b2b; }
.ryh-panel {
  position: fixed; right: 20px; bottom: 20px; width: 380px; max-width: calc(100vw - 40px);
  max-height: 72vh; display: none; flex-direction: column; overflow: hidden;
  background: #0f1216; color: #e8eaed; border: 1px solid #2a2f37; border-radius: 14px;
  box-shadow: 0 12px 40px rgba(0,0,0,.5);
}
.ryh-panel.open { display: flex; }
.ryh-topbar { display: flex; align-items: center; justify-content: space-between;
  padding: 11px 13px; border-bottom: 1px solid #20252d; }
.ryh-topbtns { display: flex; align-items: center; gap: 8px; }
.ryh-hand { background: none; border: none; font-size: 15px; cursor: pointer; opacity: .7; line-height: 1; }
.ryh-hand:hover { opacity: 1; }
.ryh-hand.on { opacity: 1; filter: drop-shadow(0 0 4px #1f6feb); }
.ryh-brand { font-weight: 700; font-size: 14px; }
.ryh-x { background: none; border: none; color: #8b949e; font-size: 15px; cursor: pointer; }
.ryh-x:hover { color: #fff; }
.ryh-head { padding: 8px 13px; font-size: 12px; color: #9aa4b2; border-bottom: 1px solid #20252d; }
.ryh-lec { color: #58a6ff; font-weight: 600; }
.ryh-note { color: #d29922; }
.ryh-status { display: none; padding: 8px 13px; font-size: 12px; color: #58a6ff; border-bottom: 1px solid #20252d; }
.ryh-status.err { color: #ff7b72; }
.ryh-prepare { display: block; margin-top: 8px; padding: 7px 12px; border: none; border-radius: 8px; background: #1f6feb; color: #fff; font-size: 13px; font-weight: 600; cursor: pointer; }
.ryh-prepare:hover { background: #2b7cff; }
.ryh-thread { flex: 1; overflow-y: auto; padding: 12px 13px; display: flex; flex-direction: column; gap: 10px; min-height: 80px; }
.ryh-msg { padding: 9px 12px; border-radius: 11px; font-size: 13.5px; line-height: 1.5; white-space: pre-wrap; word-wrap: break-word; }
.ryh-user { align-self: flex-end; background: #1f6feb; color: #fff; border-bottom-right-radius: 3px; max-width: 85%; }
.ryh-agent { align-self: flex-start; background: #191f27; border: 1px solid #262d37; border-bottom-left-radius: 3px; max-width: 92%; }
.ryh-agent.streaming::after { content: "▋"; animation: ryh-blink 1s steps(2) infinite; }
.ryh-agent.error { color: #ff7b72; border-color: #472; }
@keyframes ryh-blink { 50% { opacity: 0; } }
.ryh-ts { background: #14304d; color: #58a6ff; border: none; border-radius: 5px; padding: 0 5px;
  margin: 0 1px; font: inherit; font-size: 12.5px; cursor: pointer; }
.ryh-ts:hover { background: #1f6feb; color: #fff; }
.ryh-fb { align-self: flex-start; display: flex; gap: 6px; margin: -4px 0 2px 2px; }
.ryh-fb-btn { background: none; border: 1px solid #262d37; border-radius: 7px; padding: 2px 8px; font-size: 13px; cursor: pointer; opacity: .55; transition: opacity .12s, background .12s; }
.ryh-fb-btn:hover { opacity: 1; background: #191f27; }
.ryh-fb-btn.picked { opacity: 1; background: #1f6feb; border-color: #1f6feb; }
.ryh-fb-btn:disabled { cursor: default; }
.ryh-inputrow { display: flex; gap: 8px; padding: 11px 13px; border-top: 1px solid #20252d; }
.ryh-input { flex: 1; resize: none; max-height: 120px; padding: 9px 11px; border-radius: 9px;
  border: 1px solid #2a323d; background: #0b0e12; color: #e8eaed; font-size: 13.5px; outline: none; }
.ryh-input:focus { border-color: #1f6feb; }
.ryh-send { padding: 0 15px; border: none; border-radius: 9px; background: #1f6feb; color: #fff;
  font-weight: 600; font-size: 13px; cursor: pointer; }
.ryh-send:hover { background: #2b7cff; }
.ryh-mic { padding: 0 10px; border: 1px solid #2a323d; border-radius: 9px; background: #0b0e12; font-size: 14px; cursor: pointer; }
.ryh-mic:hover { border-color: #1f6feb; }
.ryh-lang { border: 1px solid #2a323d; border-radius: 9px; background: #0b0e12; color: #e6edf3;
  font-size: 12px; font-weight: 600; padding: 0 4px; cursor: pointer; }
.ryh-lang:hover { border-color: #1f6feb; }
.ryh-mic.live { background: #b62324; border-color: #b62324; animation: ryh-pulse 1s ease-in-out infinite; }
@keyframes ryh-pulse { 50% { opacity: .55; } }
`;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();

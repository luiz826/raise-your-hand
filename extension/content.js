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
  const HISTORY_RESET_GAP = 30; // seconds; a bigger seek starts a fresh session

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
  let root, chip, panel, header, status, thread, input, askBtn;
  let preparing = false;

  function buildUI() {
    const host = $("div", { id: "ryh-root" });
    document.documentElement.append(host);
    root = host.attachShadow({ mode: "open" });
    root.append($("style", { textContent: STYLE }));

    chip = $("button", { className: "ryh-chip", title: "Ask about this moment (Shift+A)" });
    chip.append("🖐", $("span", { textContent: "Ask" }));
    chip.onclick = openPanel;
    root.append(chip);

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
    askBtn = $("button", { className: "ryh-send", textContent: "Ask" });
    askBtn.onclick = ask;
    const inputRow = $("div", { className: "ryh-inputrow" }, input, askBtn);

    panel = $("div", { className: "ryh-panel" },
      $("div", { className: "ryh-topbar" },
        $("div", { className: "ryh-brand" }, "🖐 Raise Your Hand"), close),
      header, status, thread, inputRow);
    root.append(panel);
  }

  function setStatus(text, isError) {
    if (!status) return;
    status.textContent = text || "";
    status.style.display = text ? "block" : "none";
    status.classList.toggle("err", !!isError);
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
    chip.classList.remove("show");
    panelOpen = true;
    input.focus();
  }
  function closePanel() {
    panel.classList.remove("open");
    panelOpen = false;
  }

  function maybeResetSession() {
    const vid = getVideoId();
    const t = video() ? video().currentTime : 0;
    if (vid !== anchor.videoId || Math.abs(t - anchor.time) > HISTORY_RESET_GAP) {
      history = [];
      anchor = { videoId: vid, time: t };
      sessionId = genId("ses");
      if (thread) thread.textContent = "";
    }
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
    input.value = "";
    input.style.height = "auto";
    const turnIndex = history.length; // 0 = first in this pause session
    addBubble("user", q);
    const answerEl = addBubble("agent", "");
    answerEl.classList.add("streaming");
    const currentTimeSeconds = video() ? video().currentTime : 0;

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

  // ---- player + navigation wiring ----
  function onPause() {
    if (!panelOpen && lectureForVideo(getVideoId())) chip.classList.add("show");
  }
  function onPlay() {
    chip.classList.remove("show");
  }

  function attachVideo() {
    const v = video();
    if (!v || v.__ryhWired) return;
    v.__ryhWired = true;
    v.addEventListener("pause", onPause);
    v.addEventListener("play", onPlay);
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
  }

  function onNavigate() {
    history = [];
    anchor = { videoId: getVideoId(), time: 0 };
    sessionId = genId("ses");
    if (thread) thread.textContent = "";
    chip.classList.remove("show");
    if (getPlaylistId() !== currentPlaylistId) loadCourse();
    else if (panelOpen) setHeader();
    attachVideo();
  }

  function init() {
    loadDeviceId();
    buildUI();
    attachVideo();
    loadCourse();
    // YouTube is a SPA — re-wire on its navigation event, and poll for the
    // video element in case it mounts after us.
    document.addEventListener("yt-navigate-finish", onNavigate);
    let tries = 0;
    const iv = setInterval(() => {
      attachVideo();
      if (video() || ++tries > 40) clearInterval(iv);
    }, 500);
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
.ryh-chip {
  position: fixed; right: 24px; bottom: 88px; display: none; align-items: center; gap: 7px;
  padding: 9px 15px; border: none; border-radius: 999px; cursor: pointer;
  background: #1f6feb; color: #fff; font-size: 14px; font-weight: 600;
  box-shadow: 0 4px 16px rgba(0,0,0,.35); transition: transform .12s, background .12s;
}
.ryh-chip.show { display: inline-flex; }
.ryh-chip:hover { background: #2b7cff; transform: translateY(-1px); }
.ryh-panel {
  position: fixed; right: 20px; bottom: 20px; width: 380px; max-width: calc(100vw - 40px);
  max-height: 72vh; display: none; flex-direction: column; overflow: hidden;
  background: #0f1216; color: #e8eaed; border: 1px solid #2a2f37; border-radius: 14px;
  box-shadow: 0 12px 40px rgba(0,0,0,.5);
}
.ryh-panel.open { display: flex; }
.ryh-topbar { display: flex; align-items: center; justify-content: space-between;
  padding: 11px 13px; border-bottom: 1px solid #20252d; }
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
`;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();

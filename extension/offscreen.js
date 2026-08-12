// Runs in a hidden offscreen document (a single-world extension page with its
// own CSP), so MediaPipe loads its WASM engine correctly — unlike a content
// script, whose isolated world can't register the engine. Owns the webcam and
// the hand-detection loop; reports gestures to the service worker, which relays
// them to the content script.

import { FilesetResolver, HandLandmarker } from "./vendor/vision_bundle.mjs";

let stream = null;
let landmarker = null;
let timer = null;
let videoEl = null;
let handWasDown = true;
let lastRaise = 0;
let ticks = 0; // detection cycles, used to throttle debug messages
let raisedStreak = 0; // consecutive frames the hand has been held up
let RAISE_HOLD = 4; // frames the hand must be held up (raised sensitivity, from settings)
let RAISE_Y = 0.5;  // palm must be above this fraction of the frame height to count as "raised"
function applySensitivity(level) {
  if (level === "high") { RAISE_HOLD = 3; RAISE_Y = 0.58; }       // easier to trigger
  else if (level === "low") { RAISE_HOLD = 6; RAISE_Y = 0.42; }   // fewer false triggers
  else { RAISE_HOLD = 4; RAISE_Y = 0.5; }
}
try {
  chrome.storage.local.get("ryhSensitivity", (r) => applySensitivity(r.ryhSensitivity));
  chrome.storage.onChanged.addListener((c, area) => { if (area === "local" && c.ryhSensitivity) applySensitivity(c.ryhSensitivity.newValue); });
} catch (_) {}

function send(msg) {
  try { chrome.runtime.sendMessage(msg); } catch (_) {}
}

// Piped to the YouTube page console (via the SW → content) so the detector can
// be diagnosed without opening the hard-to-reach offscreen console.
function debug(info) {
  send({ type: "ryh-gesture-debug", info });
}

async function start() {
  try {
    // A larger frame gives MediaPipe far more to work with — hand detection at
    // 320x240 was flaky, especially away from the camera or in dim light.
    stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false });
    videoEl = document.createElement("video");
    videoEl.autoplay = true;
    videoEl.muted = true;
    videoEl.playsInline = true;
    videoEl.srcObject = stream;
    document.body.appendChild(videoEl);
    // A hidden offscreen document won't autoplay on its own — without an explicit
    // play() the element never produces frames and MediaPipe sees an empty image.
    await videoEl.play().catch((e) => debug(`video.play() failed: ${(e && e.message) || e}`));
    await new Promise((res) => {
      if (videoEl.readyState >= 2) return res();
      videoEl.onloadeddata = () => res();
    });
    debug(`camera up: ${videoEl.videoWidth}x${videoEl.videoHeight}, readyState=${videoEl.readyState}`);

    const fileset = await FilesetResolver.forVisionTasks("./vendor/wasm");
    landmarker = await HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: "./vendor/hand_landmarker.task" },
      numHands: 1,
      runningMode: "VIDEO",
      // Higher detection confidence so a half-seen/hallucinated hand doesn't fire.
      minHandDetectionConfidence: 0.6,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });

    timer = setInterval(detect, 120);
    send({ type: "ryh-gesture-ready" });
  } catch (e) {
    // An offscreen document can't show the camera permission prompt. If the
    // extension origin hasn't been granted the camera yet, getUserMedia throws
    // NotAllowedError with no prompt — ask the service worker to prime the grant
    // via a visible page, then it recreates us to retry.
    if (e && e.name === "NotAllowedError") {
      send({ type: "ryh-need-camera-permission" });
    } else {
      send({ type: "ryh-gesture-error", message: String((e && e.message) || e) });
    }
  }
}

// "Hand raised" = the deliberate classroom gesture: an OPEN palm held up high —
// all four fingers clearly extended and the hand roughly upright. Just placing
// any hand-shaped thing in the upper frame (a fist, one pointing finger, a hand
// reaching for the mouse) must NOT count. y grows downward, so smaller y = higher.
// Landmark map: 0 wrist; per finger [tip, pip, mcp] = [8,6,5] index, [12,10,9]
// middle, [16,14,13] ring, [20,18,17] pinky; 9 ≈ palm centre.
function isRaised(lm) {
  if (lm[9].y >= RAISE_Y) return false; // palm must be high in the frame
  const wrist = lm[0];
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  // Each finger must be extended — rotation-invariant check: the tip sits
  // clearly farther from the wrist (and from its own base) than the middle
  // joint. A curled/folded finger fails both comparisons.
  for (const [tip, pip, mcp] of [[8, 6, 5], [12, 10, 9], [16, 14, 13], [20, 18, 17]]) {
    if (d(lm[tip], wrist) < d(lm[pip], wrist) * 1.15) return false;
    if (d(lm[tip], lm[mcp]) < d(lm[pip], lm[mcp]) * 1.4) return false;
  }
  // Hand roughly upright: middle fingertip well above the wrist.
  if (lm[12].y > lm[0].y - 0.12) return false;
  return true;
}

function detect() {
  if (!landmarker || !videoEl) return;
  ticks++;
  if (videoEl.readyState < 2) {
    if (ticks % 14 === 0) debug(`video not ready (readyState=${videoEl.readyState})`);
    return;
  }
  let res;
  try {
    res = landmarker.detectForVideo(videoEl, performance.now());
  } catch (e) {
    if (ticks % 14 === 0) debug(`detect error: ${(e && e.message) || e}`);
    return;
  }
  const hands = (res && res.landmarks) || [];
  // A deliberate raise = the hand held up high…
  const raised = hands.length > 0 && isRaised(hands[0]);
  // …for several frames, so a passing motion or a one-frame glitch is ignored.
  raisedStreak = raised ? raisedStreak + 1 : 0;
  const held = raisedStreak >= RAISE_HOLD;

  if (ticks % 7 === 0) {
    const palmY = hands.length > 0 ? hands[0][9].y.toFixed(2) : "-";
    debug(`hands=${hands.length} palmY=${palmY} pose=${raised} streak=${raisedStreak} t=${videoEl.currentTime.toFixed(1)}`);
  }

  if (held && handWasDown && Date.now() - lastRaise > 4000) {
    handWasDown = false;
    lastRaise = Date.now();
    debug("hand raised → triggering");
    send({ type: "ryh-handraise" });
  } else if (!raised) {
    handWasDown = true; // re-arm once the hand is lowered
  }
}

// The content script suspends detection while a question is being asked and
// answered, so hand movement mid-turn can't fire another trigger. We stop and
// restart the loop; the camera stays on, so resuming is instant. On resume we
// require a fresh down→up so a hand that's still up doesn't immediately re-fire.
function setDetecting(on) {
  if (on) {
    if (!timer && landmarker) {
      handWasDown = false; // require a fresh down→up so a still-raised hand won't re-fire
      lastRaise = 0;       // but don't impose an extra debounce wait on resume
      raisedStreak = 0;    // require a fresh sustained hold
      timer = setInterval(detect, 120);
      debug("detection resumed");
    }
  } else if (timer) {
    clearInterval(timer);
    timer = null;
    debug("detection suspended");
  }
}

// The content script routes suspend/resume through the service worker (sender is
// the extension, not a tab). Ignore the copy that may also arrive straight from
// the content script so we act on it exactly once.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === "ryh-gesture-suspend" && !(sender && sender.tab)) setDetecting(!msg.on);
});

start();

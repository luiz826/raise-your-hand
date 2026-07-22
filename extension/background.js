// Service worker: (1) captures the visible tab frame for 📷 visual questions,
// (2) manages the offscreen document that runs webcam hand-detection and relays
// its gesture messages to the content script (offscreen can't message a content
// script directly), and (3) primes the camera permission via a visible page,
// because an offscreen document can't show the permission prompt itself.

// A Q&A turn can outlast the ~30s MV3 idle timeout while detection is suspended,
// so the worker may be terminated mid-session and lose this in-memory value.
// Persist it in storage.session so the offscreen→content relay still works when
// the worker is revived by the next gesture message.
const TAB_KEY = "ryhGestureTabId";
let gestureTabId = null;   // the YouTube tab that started hands-free
let permissionTabId = null; // the visible camera-permission page, while open
let permissionPrimed = false; // guards against a prompt→retry→prompt loop

function setGestureTab(id) {
  gestureTabId = id;
  try { chrome.storage.session.set({ [TAB_KEY]: id }); } catch (_) {}
}

async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument();
  if (!has) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["USER_MEDIA"],
      justification: "Detect a raised-hand gesture from the webcam to start a spoken question.",
    });
  }
}

async function closeOffscreen() {
  if (await chrome.offscreen.hasDocument()) {
    await chrome.offscreen.closeDocument().catch(() => {});
  }
}

async function relayToContent(msg) {
  if (gestureTabId == null) {
    try { gestureTabId = (await chrome.storage.session.get(TAB_KEY))[TAB_KEY] ?? null; } catch (_) {}
  }
  if (gestureTabId != null) chrome.tabs.sendMessage(gestureTabId, msg).catch(() => {});
}

function teardown() {
  closeOffscreen();
  if (permissionTabId != null) { chrome.tabs.remove(permissionTabId).catch(() => {}); permissionTabId = null; }
  setGestureTab(null);
  permissionPrimed = false;
}

// If the user closes the permission tab without deciding, don't leave the
// content script stuck "starting".
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === permissionTabId) {
    permissionTabId = null;
    relayToContent({ type: "ryh-gesture-error", message: "Camera permission was not granted." });
    teardown();
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  // Content script → capture the visible tab frame.
  if (msg.type === "ryh-capture") {
    const windowId = sender.tab ? sender.tab.windowId : chrome.windows.WINDOW_ID_CURRENT;
    chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 70 }, (dataUrl) => {
      if (chrome.runtime.lastError || !dataUrl) {
        sendResponse({ error: (chrome.runtime.lastError && chrome.runtime.lastError.message) || "capture failed" });
      } else {
        sendResponse({ dataUrl });
      }
    });
    return true; // async
  }

  // Content script → start hands-free (spin up the offscreen detector).
  if (msg.type === "ryh-gesture-start") {
    setGestureTab(sender.tab ? sender.tab.id : null);
    permissionPrimed = false;
    ensureOffscreen()
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ error: String((e && e.message) || e) }));
    return true; // async
  }

  // Content script → stop hands-free (tear everything down, freeing the camera).
  if (msg.type === "ryh-gesture-stop") {
    teardown();
    return;
  }

  // Content script → suspend/resume webcam detection during a Q&A turn. Forward
  // to the offscreen document (the reliable SW→offscreen path; the offscreen
  // ignores the copy it may also receive straight from the content script).
  if (msg.type === "ryh-gesture-suspend" && sender.tab) {
    chrome.runtime.sendMessage({ type: "ryh-gesture-suspend", on: msg.on }).catch(() => {});
    return;
  }

  // Offscreen → the camera isn't granted for the extension yet and it can't
  // prompt. Open a visible page to prime the grant, then retry once.
  if (msg.type === "ryh-need-camera-permission") {
    if (permissionPrimed) {
      relayToContent({ type: "ryh-gesture-error", message: "Camera is blocked for this extension. Enable it in Chrome's site settings and try again." });
      teardown();
      return;
    }
    permissionPrimed = true;
    closeOffscreen().then(() => {
      chrome.tabs.create({ url: chrome.runtime.getURL("permission.html") }, (tab) => {
        permissionTabId = tab ? tab.id : null;
      });
    });
    return;
  }

  // Permission page → the user allowed or denied the camera.
  if (msg.type === "ryh-camera-permission-result") {
    const fromPermTab = sender.tab && sender.tab.id === permissionTabId;
    if (fromPermTab) { permissionTabId = null; chrome.tabs.remove(sender.tab.id).catch(() => {}); }
    if (msg.granted) {
      ensureOffscreen().catch((e) => relayToContent({ type: "ryh-gesture-error", message: String((e && e.message) || e) }));
    } else {
      relayToContent({ type: "ryh-gesture-error", message: msg.message || "Camera permission denied." });
      teardown();
    }
    return;
  }

  // Offscreen → relay ready / error / handraise / debug back to the content tab.
  if (msg.type === "ryh-handraise" || msg.type === "ryh-gesture-ready" ||
      msg.type === "ryh-gesture-error" || msg.type === "ryh-gesture-debug") {
    relayToContent(msg);
    return;
  }
});

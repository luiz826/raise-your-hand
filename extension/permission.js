// A visible extension page whose only job is to obtain the camera permission
// for the extension origin. The offscreen document that runs hand-detection
// can't show a prompt, so we prompt here once; the grant then persists and the
// offscreen document can open the camera silently.

const msg = document.getElementById("msg");
const btn = document.getElementById("grant");

async function requestCamera() {
  msg.textContent = "";
  msg.className = "";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    stream.getTracks().forEach((t) => t.stop()); // we only needed the grant
    msg.textContent = "Camera enabled — you can close this tab.";
    msg.className = "ok";
    try { chrome.runtime.sendMessage({ type: "ryh-camera-permission-result", granted: true }); } catch (_) {}
    setTimeout(() => window.close(), 700); // closes automatically if opened by the extension
  } catch (e) {
    const denied = e && (e.name === "NotAllowedError" || e.name === "SecurityError");
    msg.textContent = denied
      ? "Camera blocked. Click the camera icon in the address bar (or the site settings) to allow it, then try again."
      : `Couldn't access the camera: ${(e && e.message) || e}`;
    msg.className = "err";
    try { chrome.runtime.sendMessage({ type: "ryh-camera-permission-result", granted: false, message: msg.textContent }); } catch (_) {}
  }
}

btn.addEventListener("click", requestCamera);
// Opening this tab is itself a user action, so most Chrome versions will show
// the prompt without a further click; the button is the fallback if not.
requestCamera();

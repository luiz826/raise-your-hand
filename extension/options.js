// Reads/writes the same chrome.storage.local keys the content script watches, so
// changes take effect immediately in open lectures (content.js listens on
// storage.onChanged). Keep the keys and defaults in sync with content.js.

const DEFAULTS = {
  ryhLang: (navigator.language || "en").toLowerCase().startsWith("pt") ? "pt-BR" : "en-US",
  ryhSpeak: true,
  ryhBarge: true,
  ryhVoice: "alloy",
  ryhGesture: true,
  ryhCapture: true,
  ryhPanel: "right",
  ryhStyle: "brief",
  ryhSpoilers: "strict",
  ryhSpeed: 1,
  ryhTimestamps: true,
  ryhFont: "m",
  ryhServer: "",
  ryhVad: 1300,
  ryhTelemetry: true,
  ryhSensitivity: "normal",
  ryhKey: "shift+a",
};

const $ = (id) => document.getElementById(id);
const savedEl = $("saved");
let savedTimer;
function flashSaved() {
  savedEl.classList.add("show");
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => savedEl.classList.remove("show"), 1200);
}
const save = (key, value) => chrome.storage.local.set({ [key]: value }, flashSaved);

chrome.storage.local.get(Object.keys(DEFAULTS), (r) => {
  const g = (k) => (r[k] === undefined ? DEFAULTS[k] : r[k]);
  $("lang").value = g("ryhLang");
  $("speak").checked = !!g("ryhSpeak");
  $("barge").checked = !!g("ryhBarge");
  $("voice").value = g("ryhVoice");
  $("gesture").checked = !!g("ryhGesture");
  $("capture").checked = !!g("ryhCapture");
  $("panel").value = g("ryhPanel");
  $("style").value = g("ryhStyle");
  $("spoilers").value = g("ryhSpoilers");
  $("speed").value = String(g("ryhSpeed"));
  $("timestamps").checked = g("ryhTimestamps") !== false;
  $("font").value = g("ryhFont");
  $("sensitivity").value = g("ryhSensitivity");
  $("telemetry").checked = g("ryhTelemetry") !== false;
  $("vad").value = String(g("ryhVad"));
  $("server").value = g("ryhServer");
  $("shortcut").textContent = fmtShortcut(g("ryhKey"));
});

$("lang").addEventListener("change", (e) => save("ryhLang", e.target.value));
$("speak").addEventListener("change", (e) => save("ryhSpeak", e.target.checked));
$("barge").addEventListener("change", (e) => save("ryhBarge", e.target.checked));
$("voice").addEventListener("change", (e) => save("ryhVoice", e.target.value));
$("gesture").addEventListener("change", (e) => save("ryhGesture", e.target.checked));
$("capture").addEventListener("change", (e) => save("ryhCapture", e.target.checked));
$("panel").addEventListener("change", (e) => save("ryhPanel", e.target.value));
$("style").addEventListener("change", (e) => save("ryhStyle", e.target.value));
$("spoilers").addEventListener("change", (e) => save("ryhSpoilers", e.target.value));
$("speed").addEventListener("change", (e) => save("ryhSpeed", parseFloat(e.target.value)));
$("timestamps").addEventListener("change", (e) => save("ryhTimestamps", e.target.checked));
$("reset").addEventListener("click", () => chrome.storage.local.set({ ...DEFAULTS }, () => location.reload()));
$("font").addEventListener("change", (e) => save("ryhFont", e.target.value));
$("sensitivity").addEventListener("change", (e) => save("ryhSensitivity", e.target.value));
$("telemetry").addEventListener("change", (e) => save("ryhTelemetry", e.target.checked));
$("vad").addEventListener("change", (e) => save("ryhVad", parseInt(e.target.value, 10)));
$("server").addEventListener("change", (e) => save("ryhServer", e.target.value.trim()));

function fmtShortcut(combo) {
  return (combo || "shift+a").split("+").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" + ");
}
let capturing = false;
$("shortcut").addEventListener("click", () => { capturing = true; $("shortcut").textContent = "Press a key…"; });
window.addEventListener("keydown", (e) => {
  if (!capturing) return;
  e.preventDefault();
  if (["Shift", "Control", "Alt", "Meta"].includes(e.key)) return; // wait for a non-modifier key
  if (e.key === "Escape") { capturing = false; chrome.storage.local.get("ryhKey", (r) => ($("shortcut").textContent = fmtShortcut(r.ryhKey || DEFAULTS.ryhKey))); return; }
  const mods = [];
  if (e.shiftKey) mods.push("shift");
  if (e.altKey) mods.push("alt");
  if (e.ctrlKey) mods.push("ctrl");
  if (e.metaKey) mods.push("meta");
  const combo = [...mods, e.key.toLowerCase()].join("+");
  capturing = false;
  save("ryhKey", combo);
  $("shortcut").textContent = fmtShortcut(combo);
});

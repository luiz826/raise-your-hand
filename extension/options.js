// Reads/writes the same chrome.storage.local keys the content script watches, so
// changes take effect immediately in open lectures (content.js listens on
// storage.onChanged). Keep the keys and defaults in sync with content.js.

const DEFAULTS = {
  ryhLang: (navigator.language || "en").toLowerCase().startsWith("pt") ? "pt-BR" : "en-US",
  ryhSpeak: true,
  ryhVoice: "alloy",
  ryhGesture: true,
  ryhCapture: true,
  ryhPanel: "right",
  ryhStyle: "brief",
  ryhSpoilers: "strict",
  ryhSpeed: 1,
  ryhTimestamps: true,
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
  $("voice").value = g("ryhVoice");
  $("gesture").checked = !!g("ryhGesture");
  $("capture").checked = !!g("ryhCapture");
  $("panel").value = g("ryhPanel");
  $("style").value = g("ryhStyle");
  $("spoilers").value = g("ryhSpoilers");
  $("speed").value = String(g("ryhSpeed"));
  $("timestamps").checked = g("ryhTimestamps") !== false;
});

$("lang").addEventListener("change", (e) => save("ryhLang", e.target.value));
$("speak").addEventListener("change", (e) => save("ryhSpeak", e.target.checked));
$("voice").addEventListener("change", (e) => save("ryhVoice", e.target.value));
$("gesture").addEventListener("change", (e) => save("ryhGesture", e.target.checked));
$("capture").addEventListener("change", (e) => save("ryhCapture", e.target.checked));
$("panel").addEventListener("change", (e) => save("ryhPanel", e.target.value));
$("style").addEventListener("change", (e) => save("ryhStyle", e.target.value));
$("spoilers").addEventListener("change", (e) => save("ryhSpoilers", e.target.value));
$("speed").addEventListener("change", (e) => save("ryhSpeed", parseFloat(e.target.value)));
$("timestamps").addEventListener("change", (e) => save("ryhTimestamps", e.target.checked));
$("reset").addEventListener("click", () => chrome.storage.local.set({ ...DEFAULTS }, () => location.reload()));

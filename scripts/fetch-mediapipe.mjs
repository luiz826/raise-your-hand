// Downloads the MediaPipe hand-tracking assets into extension/vendor/ (gitignored
// — they're ~19MB). The packed extension includes them; a fresh clone runs this
// once. Run: npm run fetch:mediapipe
import fs from "node:fs";

const V = "0.10.35";
const base = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${V}`;
const files = [
  [`${base}/vision_bundle.mjs`, "extension/vendor/vision_bundle.mjs"],
  [`${base}/wasm/vision_wasm_internal.wasm`, "extension/vendor/wasm/vision_wasm_internal.wasm"],
  [`${base}/wasm/vision_wasm_internal.js`, "extension/vendor/wasm/vision_wasm_internal.js"],
  [
    "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
    "extension/vendor/hand_landmarker.task",
  ],
];

fs.mkdirSync("extension/vendor/wasm", { recursive: true });
for (const [url, dest] of files) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  const b = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(dest, b);
  console.log(`${dest} (${(b.length / 1e6).toFixed(1)} MB)`);
}
console.log("MediaPipe assets ready.");

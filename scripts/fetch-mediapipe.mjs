// Downloads the MediaPipe hand-tracking assets into extension/vendor/ (gitignored
// — they're ~19MB). The packed extension includes them; a fresh clone runs this
// once. Run: npm run fetch:mediapipe
//
// SHA-256 pinned: these files run inside the extension with camera access, so a
// compromised/mutated CDN artifact must fail the build instead of shipping.
// To bump the version: update V, run with RYH_UPDATE_HASHES=1 to print the new
// hashes, verify them against the upstream release, paste them below.
import fs from "node:fs";
import crypto from "node:crypto";

const V = "0.10.35";
const base = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${V}`;
const files = [
  [`${base}/vision_bundle.mjs`, "extension/vendor/vision_bundle.mjs",
    "55d7ab624fbb70dcc5adc4ae6d7ea9cfcb569139d3dbfbf2b1deafcb966bc0fe"],
  [`${base}/wasm/vision_wasm_internal.wasm`, "extension/vendor/wasm/vision_wasm_internal.wasm",
    "6a5c64584c2ab61c763b6e204afbdbc7ce1caf7f5216187322bca8df94f646bc"],
  [`${base}/wasm/vision_wasm_internal.js`, "extension/vendor/wasm/vision_wasm_internal.js",
    "e7fd9858e8e8f221d9b96eddc11f8e077f263e0b7bbd79d3cbe882b134274f8c"],
  [
    "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
    "extension/vendor/hand_landmarker.task",
    "fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1",
  ],
];

fs.mkdirSync("extension/vendor/wasm", { recursive: true });
for (const [url, dest, sha256] of files) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
  const b = Buffer.from(await r.arrayBuffer());
  const hash = crypto.createHash("sha256").update(b).digest("hex");
  if (process.env.RYH_UPDATE_HASHES === "1") {
    console.log(`${dest}: ${hash}`);
  } else if (hash !== sha256) {
    throw new Error(
      `integrity mismatch for ${dest}\n  expected ${sha256}\n  got      ${hash}\n` +
        "Refusing to ship unverified code. If you bumped the version, see the header comment.",
    );
  }
  fs.writeFileSync(dest, b);
  console.log(`${dest} (${(b.length / 1e6).toFixed(1)} MB)`);
}
console.log("MediaPipe assets ready.");

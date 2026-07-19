// Quick network smoke test: fetch one video's metadata + transcript.
// Usage: npm run smoke [-- <videoId>]

import { fetchVideo, formatTime } from "../src/lib/youtube";

const videoId = process.argv[2] ?? "aircAruvnKk"; // 3Blue1Brown: "But what is a neural network?"
const v = await fetchVideo(videoId);
console.log(`title:       ${v.title}`);
console.log(`duration:    ${formatTime(v.durationSeconds)}`);
console.log(`captions:    ${v.captionKind} (${v.captionLanguage}), ${v.segments.length} segments`);
console.log(`description: ${v.description.length} chars`);
console.log("first segments:");
for (const s of v.segments.slice(0, 5)) {
  console.log(`  [${formatTime(s.start)}] ${s.text}`);
}

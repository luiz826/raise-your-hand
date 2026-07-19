// Ingest a course: playlist URL -> transcripts -> course map JSON.
// Usage: npm run ingest -- "https://www.youtube.com/playlist?list=..."

import "./lib/env";
import fs from "node:fs";
import path from "node:path";
import {
  fetchPlaylist,
  fetchVideo,
  parsePlaylistId,
  type VideoData,
} from "./lib/youtube";
import { buildCourseMap, emptyUsage } from "./lib/coursemap";
import { INGEST_MODEL } from "./lib/models";
import { resolveModel } from "./lib/provider";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const input = process.argv[2];
  if (!input) {
    console.error('usage: npm run ingest -- "<playlist url or id>"');
    process.exit(1);
  }
  const playlistId = parsePlaylistId(input);
  const dir = path.join("data", playlistId);
  fs.mkdirSync(path.join(dir, "transcripts"), { recursive: true });

  console.log(`playlist ${playlistId} — fetching…`);
  const playlist = await fetchPlaylist(playlistId);
  console.log(`"${playlist.title}" — ${playlist.videos.length} videos`);
  if (playlist.truncated) {
    console.log("(playlist has >100 videos; spike ingests the first 100)");
  }
  fs.writeFileSync(
    path.join(dir, "playlist.json"),
    JSON.stringify(playlist, null, 2),
  );

  const videos: VideoData[] = [];
  for (const v of playlist.videos) {
    const file = path.join(dir, "transcripts", `${String(v.index).padStart(2, "0")}-${v.videoId}.json`);
    if (fs.existsSync(file)) {
      const cached = JSON.parse(fs.readFileSync(file, "utf8")) as VideoData;
      videos.push(cached);
      console.log(`  [${v.index}/${playlist.videos.length}] cached: ${v.title}`);
      continue;
    }
    process.stdout.write(`  [${v.index}/${playlist.videos.length}] ${v.title} … `);
    try {
      const data = await fetchVideo(v.videoId);
      fs.writeFileSync(file, JSON.stringify(data, null, 2));
      videos.push(data);
      console.log(`${data.segments.length} segments (${data.captionKind}/${data.captionLanguage})`);
    } catch (err) {
      console.log(`SKIPPED — ${(err as Error).message}`);
    }
    await sleep(300); // be polite to YouTube
  }
  if (videos.length === 0) {
    console.error("no transcripts fetched; aborting");
    process.exit(1);
  }

  const model = resolveModel(INGEST_MODEL);
  console.log(`\nbuilding course map with ${model.spec}…`);
  const totals = emptyUsage();
  const map = await buildCourseMap(model, playlist, videos, totals, (m) =>
    console.log(`  ${m}`),
  );
  fs.writeFileSync(path.join(dir, "coursemap.json"), JSON.stringify(map, null, 2));

  console.log(`\ndone → ${path.join(dir, "coursemap.json")}`);
  console.log(
    `tokens: input ${totals.input}, output ${totals.output}, cache-write ${totals.cacheWrite}, cache-read ${totals.cacheRead}`,
  );
  console.log(`\nask questions with:\n  npm run ask -- ${playlistId} --lecture 1 --time 10:00`);
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(msg);
  if (/401|api key|credential/i.test(msg)) {
    console.error("Check the API key for this provider in .env.");
  }
  process.exit(1);
});

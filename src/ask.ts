// REPL Q&A against an ingested course, simulating a pause at a timestamp.
// Usage: npm run ask -- <playlistId> [--lecture N] [--time mm:ss]
// Commands inside the REPL: /seek mm:ss   /lecture N [mm:ss]   /exit

import "./lib/env";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { formatTime, parsePlaylistId, parseTime, type VideoData } from "./lib/youtube";
import { type CourseMap } from "./lib/coursemap";
import { QA_MODEL } from "./lib/models";
import { resolveModel } from "./lib/provider";
import { assembleSegments, loadVideo, runQA, type PriorTurn } from "./lib/agent";

interface Session {
  lectureIndex: number;
  pauseSeconds: number;
  video: VideoData;
  history: PriorTurn[];
}

function parseArgs(argv: string[]) {
  const playlistId = parsePlaylistId(argv[0] ?? "");
  let lecture = 1;
  let time = 0;
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === "--lecture") lecture = Number(argv[++i]);
    else if (argv[i] === "--time") time = parseTime(argv[++i]);
  }
  return { playlistId, lecture, time };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("usage: npm run ask -- <playlistId> [--lecture N] [--time mm:ss]");
    process.exit(1);
  }
  const { playlistId, lecture, time } = parseArgs(args);
  const dir = path.join("data", playlistId);
  const mapFile = path.join(dir, "coursemap.json");
  if (!fs.existsSync(mapFile)) {
    console.error(`no course map at ${mapFile} — run ingest first`);
    process.exit(1);
  }
  const map = JSON.parse(fs.readFileSync(mapFile, "utf8")) as CourseMap;
  const qaModel = resolveModel(QA_MODEL);

  const session: Session = {
    lectureIndex: lecture,
    pauseSeconds: time,
    video: loadVideo(dir, map, lecture),
    history: [],
  };

  const banner = () =>
    console.log(
      `\n📚 ${map.courseTitle}\n▶ Lecture ${session.lectureIndex}: ${session.video.title} — paused at ${formatTime(session.pauseSeconds)}\n(model: ${qaModel.spec} | /seek mm:ss, /lecture N [mm:ss], /exit)\n`,
    );
  banner();

  async function handle(text: string): Promise<void> {
    if (text === "/exit" || text === "/quit") process.exit(0);
    try {
      if (text.startsWith("/seek ")) {
        session.pauseSeconds = parseTime(text.slice(6).trim());
        session.history = []; // context changed; keep the spike simple
        banner();
        return;
      }
      if (text.startsWith("/lecture ")) {
        const parts = text.slice(9).trim().split(/\s+/);
        session.lectureIndex = Number(parts[0]);
        session.pauseSeconds = parts[1] ? parseTime(parts[1]) : 0;
        session.video = loadVideo(dir, map, session.lectureIndex);
        session.history = [];
        banner();
        return;
      }

      process.stdout.write("\n");
      const segments = assembleSegments(
        map,
        session.lectureIndex,
        session.pauseSeconds,
        session.video.segments,
        session.history,
        text,
      );
      const { text: answer, usage } = await runQA(qaModel, segments, (t) =>
        process.stdout.write(t),
      );
      session.history.push({ question: text, answer });

      console.log(
        `\n\x1b[2m[in ${usage.input} | cache-read ${usage.cacheRead} | cache-write ${usage.cacheWrite} | out ${usage.output}]\x1b[0m\n`,
      );
    } catch (err) {
      console.error(`\n${err instanceof Error ? err.message : err}`);
    }
  }

  // Piped stdin delivers every line up front; queue them so answers run in
  // order and the process exits only after in-flight requests finish.
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt("🖐 > ");
  const queue: string[] = [];
  let processing = false;
  let stdinClosed = false;

  async function drain(): Promise<void> {
    if (processing) return;
    processing = true;
    while (queue.length > 0) {
      const text = queue.shift()!;
      if (text) await handle(text);
    }
    processing = false;
    if (stdinClosed) process.exit(0);
    rl.prompt();
  }

  rl.prompt();
  rl.on("line", (line) => {
    queue.push(line.trim());
    void drain();
  });
  rl.on("close", () => {
    stdinClosed = true;
    if (!processing) process.exit(0);
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

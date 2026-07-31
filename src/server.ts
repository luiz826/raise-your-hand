// Thin backend for the Chrome extension. Holds the API key, loads ingested
// course maps from data/, and streams Q&A answers as NDJSON. Stateless per
// request: the extension sends prior turns and the current pause point; the
// cached session block (per lecture+pause) does the token-saving work.
//
// Usage: npm run server   (default port 8787, override with PORT)

import "./lib/env";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { formatTime, type PlaylistInfo, type VideoData } from "./lib/youtube";
import { buildCourseMap, emptyUsage, type CourseMap } from "./lib/coursemap";
import { INGEST_MODEL, QA_MODEL } from "./lib/models";
import { resolveModel } from "./lib/provider";
import { assembleSegments, loadVideo, runQA, type PriorTurn } from "./lib/agent";
import { logEvent, newId } from "./lib/events";
import { acquireIngestSlot, rateLimit, releaseIngestSlot } from "./lib/guard";

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? "127.0.0.1"; // bind localhost by default; set 0.0.0.0 to expose
const ALLOWED_ORIGIN = process.env.RYH_ALLOWED_ORIGIN ?? "*"; // lock to the extension origin on deploy
const API_TOKEN = process.env.RYH_API_TOKEN ?? ""; // if set, /ingest requires Authorization: Bearer <token>
const LOG_TEXT = process.env.RYH_LOG_TEXT !== "0"; // set 0 to omit question/answer text from telemetry
const qaModel = resolveModel(QA_MODEL);

// IDs arrive from the client and end up in filesystem paths, so validate them
// hard (only YouTube's id charset) — no "/" or ".." → no path traversal.
const PLAYLIST_RE = /^[A-Za-z0-9_-]{1,64}$/;
const VIDEO_RE = /^[A-Za-z0-9_-]{1,20}$/;
const validId = (s: unknown, re: RegExp): s is string => typeof s === "string" && re.test(s);

// Rate limits (per device id, falling back to IP).
const ASK_PER_MIN = Number(process.env.RYH_ASK_PER_MIN ?? 30);
const INGEST_PER_HOUR = Number(process.env.RYH_INGEST_PER_HOUR ?? 5);
const MAX_CONCURRENT_INGESTS = Number(process.env.RYH_MAX_INGESTS ?? 2);

// Rate-limit by source IP — not the client-supplied deviceId (which can be
// rotated to bypass limits). Behind a proxy, trust X-Forwarded-For instead.
function clientKey(req: http.IncomingMessage): string {
  return req.socket.remoteAddress || "unknown";
}

function checkToken(req: http.IncomingMessage): boolean {
  if (!API_TOKEN) return true; // auth disabled (local/dev)
  return req.headers["authorization"] === `Bearer ${API_TOKEN}`;
}

interface LoadedCourse {
  map: CourseMap;
  videos: Map<number, VideoData>;
}
const courseCache = new Map<string, LoadedCourse | null>();

function loadCourse(playlistId: string): LoadedCourse | null {
  if (courseCache.has(playlistId)) return courseCache.get(playlistId)!;
  const dir = path.join("data", playlistId);
  const mapFile = path.join(dir, "coursemap.json");
  if (!fs.existsSync(mapFile)) {
    courseCache.set(playlistId, null);
    return null;
  }
  const map = JSON.parse(fs.readFileSync(mapFile, "utf8")) as CourseMap;
  const loaded: LoadedCourse = { map, videos: new Map() };
  courseCache.set(playlistId, loaded);
  return loaded;
}

function lectureForVideo(map: CourseMap, videoId: string) {
  return map.lectures.find((l) => l.videoId === videoId) ?? null;
}

function cors(res: http.ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  cors(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: http.IncomingMessage, maxBytes = 1_000_000): Promise<any> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const c of req) {
    total += (c as Buffer).length;
    if (total > maxBytes) throw new Error("request body too large");
    chunks.push(c as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

// GET /course?playlistId=... — course metadata + videoId→lecture map so the
// extension can show readiness and resolve the current video.
function handleCourse(res: http.ServerResponse, playlistId: string) {
  if (!validId(playlistId, PLAYLIST_RE)) return sendJson(res, 400, { error: "valid playlistId required" });
  const course = loadCourse(playlistId);
  if (!course) return sendJson(res, 200, { ingested: false, playlistId });
  sendJson(res, 200, {
    ingested: true,
    playlistId,
    courseTitle: course.map.courseTitle,
    courseSiteUrl: course.map.courseSiteUrl,
    lectures: course.map.lectures.map((l) => ({
      index: l.index,
      videoId: l.videoId,
      title: l.title,
    })),
  });
}

interface AskBody {
  playlistId?: string;
  videoId?: string;
  currentTimeSeconds?: number;
  question?: string;
  history?: PriorTurn[];
  deviceId?: string;
  sessionId?: string; // a "pause session"; resets on seek/navigation in the extension
  turnIndex?: number; // 0 = first question in a pause session; >0 = follow-up
  image?: { mediaType?: string; base64?: string }; // captured video frame for a visual question
  answerLanguage?: string; // the learner's chosen language (e.g. "Brazilian Portuguese") — force the reply into it
  answerStyle?: string;    // "brief" (default) | "detailed"
  spoilers?: string;       // "strict" (default) | "relaxed"
}

// POST /ask — streams NDJSON: {type:"meta"|"delta"|"done"|"error", ...}
async function handleAsk(res: http.ServerResponse, body: AskBody, key: string) {
  cors(res);
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const emit = (obj: unknown) => res.write(JSON.stringify(obj) + "\n");

  try {
    if (!rateLimit(`ask:${key}`, ASK_PER_MIN, 60_000)) {
      emit({ type: "error", message: "Too many questions — slow down a moment." });
      return res.end();
    }
    const { playlistId, videoId, question } = body;
    if (!validId(playlistId, PLAYLIST_RE) || !validId(videoId, VIDEO_RE) || !question?.trim()) {
      emit({ type: "error", message: "valid playlistId, videoId and question required" });
      return res.end();
    }
    const course = loadCourse(playlistId);
    if (!course) {
      emit({ type: "error", code: "not_ingested", message: "This course hasn't been prepared yet." });
      return res.end();
    }
    const lecture = lectureForVideo(course.map, videoId);
    if (!lecture) {
      emit({ type: "error", code: "video_not_in_course", message: "This video isn't part of the prepared course." });
      return res.end();
    }

    let video = course.videos.get(lecture.index);
    if (!video) {
      video = loadVideo(path.join("data", playlistId), course.map, lecture.index);
      course.videos.set(lecture.index, video);
    }

    const pauseSeconds = Math.max(0, Math.floor(body.currentTimeSeconds ?? 0));
    const answerId = newId("ans");
    emit({
      type: "meta",
      lectureIndex: lecture.index,
      lectureTitle: lecture.title,
      pauseTime: formatTime(pauseSeconds),
    });

    const image =
      body.image?.base64 && body.image.base64.length > 0
        ? { mediaType: body.image.mediaType || "image/jpeg", base64: body.image.base64 }
        : undefined;
    // Sanitize the client-supplied language before it enters the system prompt
    // (strip newlines + cap length so it can't inject prompt instructions).
    const answerLanguage =
      typeof body.answerLanguage === "string"
        ? body.answerLanguage.replace(/[\r\n]+/g, " ").slice(0, 40)
        : undefined;
    const answerStyle = body.answerStyle === "detailed" ? "detailed" : "brief";
    const spoilers = body.spoilers === "relaxed" ? "relaxed" : "strict";
    const segments = assembleSegments(
      course.map,
      lecture.index,
      pauseSeconds,
      video.segments,
      (body.history ?? []).slice(-6), // cap replayed context
      question.trim(),
      image,
      answerLanguage,
      answerStyle,
      spoilers,
    );

    const { text: answer, usage } = await runQA(qaModel, segments, (t) =>
      emit({ type: "delta", text: t }),
    );
    logEvent({
      t: "ask",
      device: body.deviceId ?? null,
      session: body.sessionId ?? null,
      answerId,
      playlistId,
      videoId,
      lecture: lecture.index,
      pauseSeconds,
      turnIndex: body.turnIndex ?? 0,
      model: qaModel.spec,
      ...(LOG_TEXT
        ? { question: question.trim(), answer }
        : { questionLen: question.trim().length, answerLen: answer.length }),
      usage,
    });
    emit({ type: "done", answerId, usage });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit({ type: "error", message });
  } finally {
    res.end();
  }
}

// POST /ingest — the extension uploads transcripts it fetched in-page (from the
// user's residential IP); the backend builds + caches the course map. Streams
// NDJSON progress. The LLM calls are why this must be server-side.
const MAX_INGEST_VIDEOS = 40;

interface IngestBody {
  playlistId?: string;
  title?: string;
  videos?: VideoData[];
}

async function handleIngest(res: http.ServerResponse, body: IngestBody, key: string) {
  cors(res);
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const emit = (obj: unknown) => res.write(JSON.stringify(obj) + "\n");
  let gotSlot = false;

  try {
    const { playlistId, title, videos } = body;
    if (!validId(playlistId, PLAYLIST_RE) || !Array.isArray(videos) || videos.length === 0) {
      emit({ type: "error", message: "valid playlistId and videos required" });
      return res.end();
    }
    if (loadCourse(playlistId)) {
      emit({ type: "done", already: true }); // already prepared — no cost
      return res.end();
    }
    if (videos.length > MAX_INGEST_VIDEOS) {
      emit({ type: "error", message: `playlist has ${videos.length} videos; MVP caps at ${MAX_INGEST_VIDEOS}` });
      return res.end();
    }
    if (!rateLimit(`ingest:${key}`, INGEST_PER_HOUR, 3_600_000)) {
      emit({ type: "error", message: "Course-prep limit reached for now — try again later." });
      return res.end();
    }
    if (!acquireIngestSlot(MAX_CONCURRENT_INGESTS)) {
      emit({ type: "error", message: "The server is preparing other courses right now — try again in a minute." });
      return res.end();
    }
    gotSlot = true;
    const valid = videos.filter(
      (v) => v && validId(v.videoId, VIDEO_RE) && Array.isArray(v.segments) && v.segments.length > 0,
    );
    if (valid.length === 0) {
      emit({ type: "error", message: "no usable transcripts uploaded" });
      return res.end();
    }

    const dir = path.join("data", playlistId);
    fs.mkdirSync(path.join(dir, "transcripts"), { recursive: true });
    const playlist: PlaylistInfo = {
      playlistId,
      title: title || playlistId,
      truncated: false,
      videos: valid.map((v, i) => ({ videoId: v.videoId, title: v.title, index: i + 1 })),
    };
    valid.forEach((v, i) => {
      fs.writeFileSync(
        path.join(dir, "transcripts", `${String(i + 1).padStart(2, "0")}-${v.videoId}.json`),
        JSON.stringify(v, null, 2),
      );
    });
    fs.writeFileSync(path.join(dir, "playlist.json"), JSON.stringify(playlist, null, 2));

    emit({ type: "progress", message: `preparing ${valid.length} lectures…` });
    const model = resolveModel(INGEST_MODEL);
    const totals = emptyUsage();
    const map = await buildCourseMap(model, playlist, valid, totals, (m) =>
      emit({ type: "progress", message: m }),
    );
    fs.writeFileSync(path.join(dir, "coursemap.json"), JSON.stringify(map, null, 2));
    courseCache.delete(playlistId); // force reload with the freshly-built map
    emit({ type: "done", lectureCount: map.lectures.length, courseTitle: map.courseTitle });
  } catch (err) {
    emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
  } finally {
    if (gotSlot) releaseIngestSlot();
    res.end();
  }
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") {
      cors(res);
      res.writeHead(204);
      return res.end();
    }
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, { ok: true, model: qaModel.spec });
    }
    if (req.method === "GET" && url.pathname === "/course") {
      return handleCourse(res, url.searchParams.get("playlistId") ?? "");
    }
    if (req.method === "POST" && url.pathname === "/ask") {
      // Public endpoint (the extension calls it) — protected by rate limits + CORS, not a token.
      const body = await readBody(req, 4_000_000); // room for a captured frame
      return handleAsk(res, body, clientKey(req));
    }
    if (req.method === "POST" && url.pathname === "/ingest") {
      // Expensive (builds a course map via the LLM) — gate it behind RYH_API_TOKEN
      // so only the maintainer can pre-ingest courses; end users use what's ready.
      if (!checkToken(req)) return sendJson(res, 401, { error: "unauthorized" });
      const body = await readBody(req, 32_000_000); // up to 40 transcripts
      return handleIngest(res, body, clientKey(req));
    }
    if (req.method === "POST" && url.pathname === "/heartbeat") {
      const b = await readBody(req, 16_000);
      // One heartbeat per HEARTBEAT_SECONDS of playback; drop floods.
      if (rateLimit(`hb:${clientKey(req)}`, 6, 60_000)) {
        logEvent({
          t: "heartbeat",
          device: b.deviceId ?? null,
          playlistId: b.playlistId ?? null,
          videoId: b.videoId ?? null,
          second: Math.max(0, Math.floor(b.currentTimeSeconds ?? 0)),
          seconds: Number(b.seconds) || 0, // playback seconds this heartbeat covers
        });
      }
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/feedback") {
      const b = await readBody(req, 16_000);
      if (!rateLimit(`fb:${clientKey(req)}`, 120, 60_000)) {
        return sendJson(res, 429, { error: "rate limited" });
      }
      const rating = b.rating === 1 || b.rating === "up" ? 1 : b.rating === -1 || b.rating === "down" ? -1 : 0;
      if (!b.answerId || rating === 0) {
        return sendJson(res, 400, { error: "answerId and rating (1|-1) required" });
      }
      logEvent({ t: "feedback", device: b.deviceId ?? null, answerId: b.answerId, rating });
      return sendJson(res, 200, { ok: true });
    }
    sendJson(res, 404, { error: "not found" });
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(PORT, HOST, () => {
  const courses = fs.existsSync("data")
    ? fs.readdirSync("data").filter((d) =>
        fs.existsSync(path.join("data", d, "coursemap.json")),
      )
    : [];
  console.log(`Raise Your Hand backend on http://${HOST}:${PORT} (model: ${qaModel.spec})`);
  console.log(`ingested courses: ${courses.length > 0 ? courses.join(", ") : "(none — run npm run ingest)"}`);
});

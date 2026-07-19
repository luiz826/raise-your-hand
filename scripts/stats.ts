// Compute the MVP success metrics from the telemetry log (data/events.jsonl).
// Usage: npm run stats
//
// Metrics (from PLAN.md §5): follow-up rate ≥30%, thumbs-up rate ≥70%.
// (Questions-per-20-min-watched needs watch-time tracking — not logged yet.)

import fs from "node:fs";
import path from "node:path";

const FILE = path.join("data", "events.jsonl");
if (!fs.existsSync(FILE)) {
  console.log("no telemetry yet — data/events.jsonl doesn't exist. Ask some questions first.");
  process.exit(0);
}

interface AskEvent {
  t: "ask";
  ts: string;
  device: string | null;
  session: string | null;
  answerId: string;
  turnIndex: number;
  model: string;
  question: string;
}
interface FeedbackEvent {
  t: "feedback";
  ts: string;
  answerId: string;
  rating: 1 | -1;
}
type Event = AskEvent | FeedbackEvent | { t: string };

const events: Event[] = fs
  .readFileSync(FILE, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

const asks = events.filter((e): e is AskEvent => e.t === "ask");
const feedback = events.filter((e): e is FeedbackEvent => e.t === "feedback");

if (asks.length === 0) {
  console.log("no `ask` events yet.");
  process.exit(0);
}

const devices = new Set(asks.map((a) => a.device ?? "?"));
const models = new Map<string, number>();
for (const a of asks) models.set(a.model, (models.get(a.model) ?? 0) + 1);

// Follow-up rate: fraction of pause sessions with ≥2 questions.
const bySession = new Map<string, number>();
for (const a of asks) {
  const key = a.session ?? `${a.device}:${a.answerId}`; // sessionless → its own bucket
  bySession.set(key, (bySession.get(key) ?? 0) + 1);
}
const sessions = [...bySession.values()];
const sessionsWithFollowup = sessions.filter((n) => n >= 2).length;
const followUpRate = sessions.length ? sessionsWithFollowup / sessions.length : 0;

// Thumbs: latest rating per answer (a user can change their mind).
const latestRating = new Map<string, 1 | -1>();
for (const f of feedback) latestRating.set(f.answerId, f.rating);
const ratings = [...latestRating.values()];
const up = ratings.filter((r) => r === 1).length;
const down = ratings.filter((r) => r === -1).length;
const thumbsUpRate = up + down ? up / (up + down) : 0;
const coverage = asks.length ? latestRating.size / asks.length : 0;

const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const bar = (ok: boolean) => (ok ? "✅" : "⚠️ ");

console.log(`Raise Your Hand — telemetry (${asks.length} questions across ${devices.size} device(s))\n`);
console.log(`questions:        ${asks.length}  (${sessions.length} pause sessions, ${(asks.length / sessions.length).toFixed(1)} Q/session)`);
console.log(`${bar(followUpRate >= 0.3)} follow-up rate:  ${pct(followUpRate)}  (target ≥30% — sessions with a 2nd+ question)`);
console.log(`${bar(coverage > 0 && thumbsUpRate >= 0.7)} thumbs-up rate:  ${pct(thumbsUpRate)}  (${up}👍 ${down}👎 — target ≥70%)`);
console.log(`   feedback coverage: ${pct(coverage)} of answers rated`);
console.log(`\nby model:`);
for (const [m, n] of [...models.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`   ${m}: ${n}`);
}
console.log(`\n(questions-per-20-min-watched needs watch-time tracking — not logged yet)`);

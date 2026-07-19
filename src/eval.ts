// Persona eval: runs curated (lecture, timestamp, question) cases against the
// agent and grades each answer with an LLM judge against the persona contract.
// Provider-neutral — agent and judge each resolve from RYH_QA_MODEL / RYH_JUDGE_MODEL.
// Usage: npm run eval [-- --course cme295|3b1b] [--only id1,id2] [--limit N]

import "./lib/env";
import fs from "node:fs";
import path from "node:path";
import { renderCourseMap } from "./lib/context";
import { assembleSegments, loadVideo, runQA } from "./lib/agent";
import { emptyUsage, type CourseMap } from "./lib/coursemap";
import { addUsage, type PromptSegment, type Usage } from "./lib/provider-types";
import { resolveModel, type ResolvedModel } from "./lib/provider";
import { compactTranscript, parseTime } from "./lib/youtube";
import { JUDGE_MODEL, QA_MODEL } from "./lib/models";

interface EvalCase {
  id: string;
  category: string;
  lecture: number;
  time: string;
  question: string;
  expected_language?: string; // default "en"
  expect_reference_lectures?: number[];
  rubric: string;
  followup?: { question: string; rubric: string };
}

interface CaseFile {
  course: string;
  playlistId: string;
  cases: EvalCase[];
}

interface Verdict {
  criteria: { name: string; pass: boolean; note: string }[];
  overall_pass: boolean;
  failure_summary: string | null;
}

const VERDICT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["criteria", "overall_pass", "failure_summary"],
  properties: {
    criteria: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "pass", "note"],
        properties: {
          name: {
            type: "string",
            description:
              "One of: scope, reference, brevity, grounding, language, tone",
          },
          pass: { type: "boolean" },
          note: { type: "string", description: "One short sentence." },
        },
      },
    },
    overall_pass: { type: "boolean" },
    failure_summary: {
      type: ["string", "null"],
      description: "One sentence naming the main failure, or null if passed.",
    },
  },
} as Record<string, unknown>;

const JUDGE_INSTRUCTIONS = `You grade answers produced by "Raise Your Hand", a TA agent embedded in a video player for online university courses. The student pauses the video at a timestamp and asks a question; the agent must answer like a TA during that pause.

The agent's contract — grade each criterion strictly:

1. scope — Material after the pause point (later in the current lecture, or in any later lecture) is UNSEEN. The agent must not teach unseen material: at most a one-sentence high-level confirmation plus a pointer to where the course covers it. Material from earlier lectures and from the current lecture before the pause is fair game to explain.
2. reference — If the case lists expected reference lectures, the answer must explicitly point the student to at least one of them (by lecture number or unambiguous title). Additionally, ANY lecture attribution or timestamp cited in the answer must be consistent with the COURSE MAP (within ~2 minutes of a matching concept) OR supported by the transcript excerpt. Give the benefit of the doubt to timestamps before the pause point in the current lecture when the excerpt is cut short. If no expected lectures are listed and no citations appear, this criterion passes.
3. brevity — Default answers are at most ~3 sentences, no headers or bullet lists. Exception: when the student's turn explicitly asks for a full/deeper explanation, depth is expected — then judge completeness instead of length.
4. grounding — Claims must be consistent with the course map and the transcript excerpt; no invented course content, misattributed concepts, or fabricated timestamps.
5. language — The answer is written in the expected language.
6. tone — Direct TA voice. Fails on filler ("Great question", "I'd be happy to"), or a lecturing structure in a default answer.

Apply the case-specific rubric on top of these. overall_pass = true only if all six criteria pass. Be strict: a borderline mini-lecture on unseen material is a scope failure, not a pass with a note.`;

function judgeSystemSegments(map: CourseMap): PromptSegment[] {
  return [
    { role: "system", text: JUDGE_INSTRUCTIONS },
    { role: "system", text: renderCourseMap(map), cacheable: true },
  ];
}

async function judgeCase(
  judge: ResolvedModel,
  judgeSys: PromptSegment[],
  map: CourseMap,
  c: EvalCase,
  transcriptTail: string,
  turns: { question: string; answer: string }[],
  totals: Usage,
): Promise<Verdict> {
  const lecture = map.lectures.find((l) => l.index === c.lecture);
  const parts = [
    `CASE ${c.id} (category: ${c.category})`,
    `Session: lecture ${c.lecture} "${lecture?.title ?? "?"}", paused at ${c.time}. Lectures 1-${c.lecture - 1} fully watched; nothing after the pause point seen.`,
    `Expected language: ${c.expected_language ?? "en"}`,
    `Expected reference lectures: ${c.expect_reference_lectures?.join(", ") ?? "none specified"}`,
    `Case rubric: ${c.rubric}`,
    ``,
    `TRANSCRIPT EXCERPT (the last part before the pause):`,
    transcriptTail,
    ``,
  ];
  turns.forEach((t, i) => {
    parts.push(`STUDENT QUESTION (turn ${i + 1}): ${t.question}`);
    if (i === 1) {
      parts.push(`(Turn 2 is an explicit escalation — depth is expected there.)`);
    }
    parts.push(`AGENT ANSWER (turn ${i + 1}): ${t.answer}`, ``);
  });
  parts.push(`Grade the agent per your instructions and the case rubric.`);

  const { text, usage } = await judge.provider.completeStructured({
    model: judge.model,
    segments: [...judgeSys, { role: "user", text: parts.join("\n") }],
    maxTokens: 8192, // thinking counts against this on reasoning models
    reasoning: "thorough",
    schemaName: "verdict",
    schema: VERDICT_SCHEMA,
  });
  addUsage(totals, usage);
  return JSON.parse(text) as Verdict;
}

interface CaseResult {
  course: string;
  id: string;
  category: string;
  passed: boolean;
  verdict: Verdict;
  turns: { question: string; answer: string }[];
}

async function runCase(
  qa: ResolvedModel,
  judge: ResolvedModel,
  dir: string,
  map: CourseMap,
  judgeSys: PromptSegment[],
  course: string,
  c: EvalCase,
  agentTotals: Usage,
  judgeTotals: Usage,
): Promise<CaseResult> {
  const video = loadVideo(dir, map, c.lecture);
  const pauseSeconds = parseTime(c.time);
  const history: { question: string; answer: string }[] = [];
  const turns: { question: string; answer: string }[] = [];

  const questions = [c.question, ...(c.followup ? [c.followup.question] : [])];
  for (const q of questions) {
    const segments = assembleSegments(
      map,
      c.lecture,
      pauseSeconds,
      video.segments,
      history,
      q,
    );
    const { text, usage } = await runQA(qa, segments);
    addUsage(agentTotals, usage);
    history.push({ question: q, answer: text });
    turns.push({ question: q, answer: text });
  }

  // Judge needs the whole watched transcript to verify citations; elide the
  // middle of very long ones to bound cost.
  const watched = compactTranscript(video.segments, pauseSeconds);
  const tail =
    watched.length <= 14000
      ? watched
      : `${watched.slice(0, 4000)}\n[... middle of transcript elided ...]\n${watched.slice(-9000)}`;
  const fullRubric = c.followup
    ? `${c.rubric} FOLLOW-UP RUBRIC (turn 2): ${c.followup.rubric}`
    : c.rubric;
  const verdict = await judgeCase(
    judge,
    judgeSys,
    map,
    { ...c, rubric: fullRubric },
    tail,
    turns,
    judgeTotals,
  );
  return { course, id: c.id, category: c.category, passed: verdict.overall_pass, verdict, turns };
}

function parseArgs(argv: string[]) {
  let course: string | null = null;
  let only: Set<string> | null = null;
  let limit = Infinity;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--course") course = argv[++i];
    else if (argv[i] === "--only") only = new Set(argv[++i].split(","));
    else if (argv[i] === "--limit") limit = Number(argv[++i]);
  }
  return { course, only, limit };
}

async function main() {
  const { course, only, limit } = parseArgs(process.argv.slice(2));
  const files = fs
    .readdirSync("eval")
    .filter((f) => f.startsWith("cases.") && f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join("eval", f), "utf8")) as CaseFile)
    .filter((cf) => !course || cf.course === course);
  if (files.length === 0) {
    console.error("no case files matched");
    process.exit(1);
  }

  const qa = resolveModel(QA_MODEL);
  const judge = resolveModel(JUDGE_MODEL);
  const agentTotals = emptyUsage();
  const judgeTotals = emptyUsage();
  const results: CaseResult[] = [];

  fs.mkdirSync("eval-results", { recursive: true });
  const outFile = path.join(
    "eval-results",
    `run-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
  );

  let remaining = limit;
  for (const cf of files) {
    const dir = path.join("data", cf.playlistId);
    const map = JSON.parse(
      fs.readFileSync(path.join(dir, "coursemap.json"), "utf8"),
    ) as CourseMap;
    const judgeSys = judgeSystemSegments(map);
    const cases = cf.cases
      .filter((c) => !only || only.has(c.id))
      .slice(0, Math.max(0, remaining));
    remaining -= cases.length;
    if (cases.length === 0) continue;

    console.log(`\n=== ${cf.course}: ${cases.length} case(s) ===`);
    const run = async (c: EvalCase) => {
      try {
        const r = await runCase(
          qa, judge, dir, map, judgeSys, cf.course, c, agentTotals, judgeTotals,
        );
        fs.appendFileSync(outFile, JSON.stringify(r) + "\n");
        console.log(
          `${r.passed ? "✅ PASS" : "❌ FAIL"}  ${r.id} (${r.category})${r.passed ? "" : ` — ${r.verdict.failure_summary}`}`,
        );
        results.push(r);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`💥 ERROR ${c.id} — ${msg}`);
        fs.appendFileSync(
          outFile,
          JSON.stringify({ course: cf.course, id: c.id, error: msg }) + "\n",
        );
      }
    };

    // First case alone (warms both agent and judge caches), then batches.
    await run(cases[0]);
    const CONCURRENCY = 3;
    for (let i = 1; i < cases.length; i += CONCURRENCY) {
      await Promise.all(cases.slice(i, i + CONCURRENCY).map(run));
    }
  }

  const passed = results.filter((r) => r.passed).length;
  console.log(`\n=== SUMMARY: ${passed}/${results.length} passed ===`);
  const byCat = new Map<string, { p: number; t: number }>();
  for (const r of results) {
    const s = byCat.get(r.category) ?? { p: 0, t: 0 };
    s.t++;
    if (r.passed) s.p++;
    byCat.set(r.category, s);
  }
  for (const [cat, s] of [...byCat.entries()].sort()) {
    console.log(`  ${cat}: ${s.p}/${s.t}`);
  }
  const criterionFails = new Map<string, number>();
  for (const r of results) {
    for (const cr of r.verdict.criteria) {
      if (!cr.pass) criterionFails.set(cr.name, (criterionFails.get(cr.name) ?? 0) + 1);
    }
  }
  if (criterionFails.size > 0) {
    console.log("failing criteria:");
    for (const [name, n] of [...criterionFails.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${name}: ${n}`);
    }
  }
  console.log(
    `\nagent tokens:  in ${agentTotals.input}, out ${agentTotals.output}, cache-write ${agentTotals.cacheWrite}, cache-read ${agentTotals.cacheRead}`,
  );
  console.log(
    `judge tokens:  in ${judgeTotals.input}, out ${judgeTotals.output}, cache-write ${judgeTotals.cacheWrite}, cache-read ${judgeTotals.cacheRead}`,
  );
  console.log(`results → ${outFile}`);
  console.log(`models: agent ${qa.spec}, judge ${judge.spec}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

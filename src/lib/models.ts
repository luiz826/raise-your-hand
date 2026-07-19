// Model selection, split by workload so the cost profile matches each job.
//
// - QA_MODEL      interactive Q&A. Tested Sonnet 5 at effort low to cut cost
//                 (2026-07-19): it regressed to 26/38 on the eval vs Opus's
//                 37/38 — scope (teaching unseen material), brevity, and
//                 grounding (fabricated timestamps), i.e. the differentiator.
//                 Kept on Opus 4.8. Per-question cost is already ~$0.02 cached.
//                 Retry Sonnet at effort medium/high before committing again.
// - INGEST_MODEL  offline course-map build. One-time per course, quality-
//                 sensitive, latency-irrelevant — Opus.
// - JUDGE_MODEL   eval grader. Trustworthy grades, runs only on persona tuning
//                 — Opus.
export const QA_MODEL = process.env.RYH_QA_MODEL ?? "claude-opus-4-8";
export const INGEST_MODEL = process.env.RYH_INGEST_MODEL ?? "claude-opus-4-8";
export const JUDGE_MODEL = process.env.RYH_JUDGE_MODEL ?? "claude-opus-4-8";

// Adaptive thinking and the `effort` param are Claude 4.6+ features; older
// models (Haiku 4.5, Sonnet 4.5, …) reject them with a 400. Gate on this so a
// cheap dev model can be swapped in without breaking the request.
const ADAPTIVE_MODELS = [
  "fable-5",
  "mythos-5",
  "opus-4-6",
  "opus-4-7",
  "opus-4-8",
  "sonnet-5",
  "sonnet-4-6",
];
export const supportsAdaptiveThinking = (model: string) =>
  ADAPTIVE_MODELS.some((m) => model.includes(m));

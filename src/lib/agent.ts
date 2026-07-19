// The Q&A turn, provider-neutral. assembleSegments() builds the whole prompt as
// PromptSegments (persona + course map + session block + prior turns + question);
// any provider realizes it. Shared by the REPL (ask.ts), eval, and server.

import fs from "node:fs";
import path from "node:path";
import { sessionSegment, systemSegments } from "./context";
import { type CourseMap } from "./coursemap";
import type { PromptSegment, LLMResult } from "./provider-types";
import type { ResolvedModel } from "./provider";
import type { VideoData } from "./youtube";

export function loadVideo(
  dataDir: string,
  map: CourseMap,
  lectureIndex: number,
): VideoData {
  const lecture = map.lectures.find((l) => l.index === lectureIndex);
  if (!lecture) {
    throw new Error(
      `no lecture ${lectureIndex} (course has ${map.lectures.length})`,
    );
  }
  const file = path.join(
    dataDir,
    "transcripts",
    `${String(lectureIndex).padStart(2, "0")}-${lecture.videoId}.json`,
  );
  return JSON.parse(fs.readFileSync(file, "utf8")) as VideoData;
}

export interface PriorTurn {
  question: string;
  answer: string;
}

// Label the question — after a long transcript block an unmarked trailing
// fragment can read as more context rather than the student's turn.
const labelled = (q: string): PromptSegment => ({
  role: "user",
  text: `The video is paused. The student asks:\n\n${q}`,
});

// The full prompt for a stateless Q&A request: the cached session block rides on
// the first user turn; prior turns replay as plain text.
export function assembleSegments(
  map: CourseMap,
  lectureIndex: number,
  pauseSeconds: number,
  videoSegments: VideoData["segments"],
  priorTurns: PriorTurn[],
  question: string,
): PromptSegment[] {
  const session = sessionSegment(map, lectureIndex, pauseSeconds, videoSegments);
  const segs: PromptSegment[] = [...systemSegments(map)];

  const firstUserTurn = (q: string): PromptSegment[] => [session, labelled(q)];
  priorTurns.forEach((t, i) => {
    if (i === 0) segs.push(...firstUserTurn(t.question));
    else segs.push({ role: "user", text: t.question });
    segs.push({ role: "assistant", text: t.answer });
  });
  if (priorTurns.length === 0) segs.push(...firstUserTurn(question));
  else segs.push({ role: "user", text: question });
  return segs;
}

// Run one Q&A turn against the resolved model.
export function runQA(
  model: ResolvedModel,
  segments: PromptSegment[],
  onDelta?: (t: string) => void,
): Promise<LLMResult> {
  return model.provider.streamText({
    model: model.model,
    segments,
    maxTokens: 2048,
    reasoning: "fast",
    onDelta,
  });
}

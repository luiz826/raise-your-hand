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
export interface QuestionImage {
  mediaType: string;
  base64: string;
}

export function assembleSegments(
  map: CourseMap,
  lectureIndex: number,
  pauseSeconds: number,
  videoSegments: VideoData["segments"],
  priorTurns: PriorTurn[],
  question: string,
  image?: QuestionImage,
  answerLanguage?: string,
  answerStyle?: string,
  spoilers?: string,
): PromptSegment[] {
  const session = sessionSegment(map, lectureIndex, pauseSeconds, videoSegments);
  const segs: PromptSegment[] = [...systemSegments(map)];
  // The learner picks a language in the extension; force the answer into it so a
  // partly-English speech transcription can't drag the reply into English. This
  // rides AFTER the cacheable course map, so it doesn't disturb the prefix cache.
  if (answerLanguage) {
    segs.push({
      role: "system",
      text: `RESPOND IN ${answerLanguage}: Write your ENTIRE answer in ${answerLanguage}. This is the student's chosen language and it overrides the default "match the question" rule — do not answer in English or any other language, even if the question looks like it is in another language (their speech was transcribed and may be imperfect).`,
    });
  }
  if (answerStyle === "detailed") {
    segs.push({
      role: "system",
      text: `ANSWER LENGTH: This student prefers fuller answers. You may go beyond three sentences and walk through the reasoning step by step — still as spoken prose (no headers, bullets, or numbered lists), anchored to the course's notation. Add depth where it aids understanding, not padding.`,
    });
  }
  if (spoilers === "relaxed") {
    segs.push({
      role: "system",
      text: `SPOILERS: This student has turned off spoiler protection. When they ask about material the course covers after the pause point, you may explain it directly instead of only deferring — still concisely and in the course's terms.`,
    });
  }

  priorTurns.forEach((t, i) => {
    if (i === 0) segs.push(session, labelled(t.question));
    else segs.push({ role: "user", text: t.question });
    segs.push({ role: "assistant", text: t.answer });
  });

  // Current question; the visual frame (if any) rides on it — not cacheable.
  const qSeg: PromptSegment = priorTurns.length === 0 ? labelled(question) : { role: "user", text: question };
  if (image) {
    qSeg.imageBase64 = image.base64;
    qSeg.imageMediaType = image.mediaType;
  }
  if (priorTurns.length === 0) segs.push(session, qSeg);
  else segs.push(qSeg);
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

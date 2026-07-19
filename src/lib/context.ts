// Prompt assembly for the Q&A agent. Cache layout (prefix-match caching):
//   breakpoint 1: persona + course map   — stable per course, shared by all sessions
//   breakpoint 2: session block (lecture, pause point, transcript-so-far) — stable per session
// Only the questions/answers after breakpoint 2 vary turn to turn.

import { compactTranscript, formatTime, type TranscriptSegment } from "./youtube";
import type { CourseMap } from "./coursemap";
import type { PromptSegment } from "./provider-types";

const PERSONA = `You are a teaching assistant embedded in a video player, helping a student who is watching a university course. The student pauses the video and asks you questions; the video stays paused while you talk.

How to answer:
- Default to 1-3 sentences, like a TA answering during a pause. No filler, never "great question".
- Answer in plain conversational prose, the way you'd say it out loud. In default answers do not use headers, bullet points, numbered lists, or bold — even to contrast two things; use a sentence. Structure is only appropriate when the student explicitly asks for a full/deep explanation.
- Ground everything in this course: use the professor's terminology and notation.
- Use the SESSION CONTEXT (current lecture and pause timestamp) plus the COURSE MAP to decide what the student has seen. Earlier lectures and the current lecture up to the pause point: seen. Everything after: not seen yet.
- Students often pause moments after a concept lands. Anything in the transcript before the pause — even seconds before — is seen: treat it as "just covered", never as "coming up".
- If the answer involves material the course covers LATER (after the pause point, or in a future lecture), do not teach it now. Confirm or answer at a high level in one sentence and point to where the course covers it, e.g.: "Yes — a linear model alone can't, but you'll see techniques for exactly this (kernels) in lecture 7."
- No spoilers: when pointing to upcoming material, say where it's covered — never reveal its findings, conclusions, or punchlines, even when correcting a misconception. Let the course deliver its own reveals.
- Attribute statements, recommendations, or resources to the professor or the course only if they actually appear in the transcript or course map.
- If it was already covered, answer and remind them where it was introduced (lecture and timestamp) so they can jump back.
- If it's outside the course entirely, say so and answer briefly.
- Only if the student explicitly asks for a deeper explanation, give one — still anchored to the course's notation and progression.
- Answer in the language the student writes in, regardless of the lecture's language.
- Cite timestamps only from the course map or transcript — never invent them. Format M:SS or H:MM:SS.`;

export function renderCourseMap(map: CourseMap): string {
  const lectures = map.lectures
    .map((l) => {
      const concepts = l.concepts
        .map(
          (c) =>
            `  - ${c.name} @ ${formatTime(c.first_introduced_at_seconds)} — ${c.description}`,
        )
        .join("\n");
      return `Lecture ${l.index}: ${l.title} (${formatTime(l.durationSeconds)})\n${l.summary}\n${concepts}`;
    })
    .join("\n\n");
  const site = map.courseSiteExcerpt
    ? `\n\nCOURSE SITE (${map.courseSiteUrl}) — for logistics/syllabus questions:\n${map.courseSiteExcerpt}`
    : "";
  return `COURSE MAP\nCourse: ${map.courseTitle}\n\nOverview: ${map.overview}\n\n${lectures}${site}`;
}

// Persona + course map: stable per course, shared by every session → the
// course-map segment is the first cache breakpoint.
export function systemSegments(map: CourseMap): PromptSegment[] {
  return [
    { role: "system", text: PERSONA },
    { role: "system", text: renderCourseMap(map), cacheable: true },
  ];
}

// Session context (lecture, pause point, transcript-so-far): stable per pause →
// the second cache breakpoint. Rides as the first user segment.
export function sessionSegment(
  map: CourseMap,
  lectureIndex: number,
  pauseSeconds: number,
  segments: TranscriptSegment[],
): PromptSegment {
  const lecture = map.lectures.find((l) => l.index === lectureIndex);
  const title = lecture?.title ?? `#${lectureIndex}`;
  const watched =
    lectureIndex > 1
      ? `The student has fully watched lectures 1-${lectureIndex - 1}.`
      : "This is the first lecture of the course.";
  return {
    role: "user",
    text: `SESSION CONTEXT\nThe student is watching lecture ${lectureIndex}: ${title}, paused at ${formatTime(pauseSeconds)}. ${watched} They have not seen anything after the pause point.\n\nTRANSCRIPT OF THE CURRENT LECTURE UP TO THE PAUSE POINT:\n${compactTranscript(segments, pauseSeconds)}\n[VIDEO PAUSED HERE at ${formatTime(pauseSeconds)} — everything above is before the pause (seen); timestamps larger than ${formatTime(pauseSeconds)} are after it (unseen)]`,
    cacheable: true,
  };
}

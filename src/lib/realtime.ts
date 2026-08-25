// OpenAI Realtime (full-duplex voice) session bootstrap. The backend mints an
// ephemeral client secret with the course context baked into the instructions;
// the extension then connects DIRECTLY to OpenAI (no audio through us — lowest
// latency for barge-in). Secrets expire in ~1 minute, just long enough to open
// the WebSocket.
import type { CourseMap } from "./coursemap";
import { formatTime } from "./youtube";

const OPENAI_KEY = process.env.OPENAI_API_KEY ?? "";
const MODEL = process.env.RYH_REALTIME_MODEL ?? "gpt-realtime";

export function realtimeInstructions(opts: {
  course?: CourseMap | null;
  videoId?: string;
  pauseSeconds?: number;
  language: string;
}): string {
  const base = [
    "You are a teaching assistant embedded in a video player, helping a student who is watching a university course on YouTube. The student paused the video and is talking to you by voice, live.",
    "Speak like a good TA during a pause: 1-3 sentences, warm and direct, conversational. Never use markdown, bullets, headers, or emojis — everything you say is spoken aloud. If the student interrupts you, stop and listen.",
    `Always answer in ${opts.language}.`,
  ];
  if (!opts.course) {
    base.push("You don't have this course's materials yet — say so and answer generally, briefly.");
    return base.join("\n");
  }
  const c = opts.course;
  const lec = c.lectures.find((l) => l.videoId === opts.videoId);
  base.push(`COURSE: ${c.courseTitle}. Overview: ${c.overview}`);
  if (lec) {
    const seen = opts.pauseSeconds ?? 0;
    const concepts = lec.concepts
      .filter((k) => k.first_introduced_at_seconds <= seen)
      .map((k) => k.name)
      .join(", ");
    base.push(
      `The student is on lecture ${lec.index}: ${lec.title}, paused at ${formatTime(seen)}. Lecture summary: ${lec.summary}`,
      concepts ? `Concepts already covered up to the pause: ${concepts}.` : "",
      "They have seen everything up to the pause point and NOTHING after it. If an answer depends on material from later in this lecture or future lectures, do not teach it: acknowledge in one sentence and say where the course covers it — never spoil findings or punchlines.",
    );
  }
  return base.filter(Boolean).join("\n");
}

export async function mintRealtimeSession(instructions: string, language: string): Promise<string> {
  if (!OPENAI_KEY) throw new Error("OPENAI_API_KEY not configured");
  const res = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({
      session: {
        type: "realtime",
        model: MODEL,
        instructions,
        audio: {
          input: {
            transcription: { model: "gpt-4o-mini-transcribe" },
            turn_detection: { type: "server_vad", create_response: true, interrupt_response: true },
          },
          output: { voice: "alloy" },
        },
      },
    }),
  });
  if (!res.ok) throw new Error(`realtime secrets HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { value?: string };
  if (!json.value) throw new Error("no ephemeral token returned");
  return json.value;
}

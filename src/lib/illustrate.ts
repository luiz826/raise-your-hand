// On-demand illustrations for the answer card's 🎨 button. The answer text +
// course context go straight into an OpenAI gpt-image-1 prompt (quality
// "medium": "low" garbles text labels — verified empirically; ~$0.04/image);
// results are cached on disk keyed by course+answer, so repeated clicks —
// from any user — are free.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const OPENAI_KEY = process.env.OPENAI_API_KEY ?? "";
const DIR = path.join("data", "illustrations");

export function illustrationKey(playlistId: string, answer: string): string {
  return crypto.createHash("sha1").update(`${playlistId}\n${answer.slice(0, 800)}`).digest("hex");
}

export function illustrationPath(key: string): string | null {
  if (!/^[a-f0-9]{40}$/.test(key)) return null; // cache keys are sha1 hex — no traversal
  const p = path.join(DIR, `${key}.png`);
  return fs.existsSync(p) ? p : null;
}

export async function generateIllustration(opts: {
  key: string;
  courseTitle: string;
  lectureTitle: string;
  answer: string;
  language: string;
}): Promise<string> {
  if (!OPENAI_KEY) throw new Error("image generation is not configured on the server");
  const prompt = [
    "A clean educational whiteboard-style diagram for a university student, illustrating this explanation:",
    `"${opts.answer.slice(0, 800)}"`,
    `Context: lecture "${opts.lectureTitle}" from the course "${opts.courseTitle}".`,
    `Style: hand-drawn black-marker sketch on white, simple shapes and arrows, at most 3-4 short text labels in ${opts.language}, every word spelled exactly right, any math notation kept minimal and standard, no photorealism, no people, no watermark, no long sentences in the image.`,
  ].join("\n");
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({ model: "gpt-image-1", prompt, size: "1024x1024", quality: "medium" }),
  });
  if (!res.ok) throw new Error(`image API HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as { data?: { b64_json?: string }[] };
  const b64 = json.data?.[0]?.b64_json;
  if (!b64) throw new Error("image API returned no image");
  fs.mkdirSync(DIR, { recursive: true });
  const p = path.join(DIR, `${opts.key}.png`);
  fs.writeFileSync(p, Buffer.from(b64, "base64"));
  return p;
}

// Provider-neutral types shared by the interface and every implementation.
// Kept in their own module so provider implementations can import them without
// creating a cycle with the resolveModel factory in provider.ts.

// One piece of the prompt. `cacheable: true` marks the end of a stable prefix —
// providers with explicit caching (Anthropic breakpoints, Gemini context cache)
// use it; providers with automatic prefix caching (OpenAI, DeepSeek) ignore it.
export interface PromptSegment {
  role: "system" | "user" | "assistant";
  text: string;
  cacheable?: boolean;
  // Optional image on a user segment (visual questions — a captured video frame).
  imageBase64?: string;
  imageMediaType?: string; // e.g. "image/jpeg"
}

// Neutral reasoning hint. Providers map it to their own knobs (or ignore it):
//  fast     — interactive Q&A: minimal/low reasoning, fast first token
//  thorough — offline ingestion/judging: allow deeper reasoning
//  none     — no reasoning
export type Reasoning = "fast" | "thorough" | "none";

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}
export const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
export function addUsage(t: Usage, u: Usage): void {
  t.input += u.input;
  t.output += u.output;
  t.cacheRead += u.cacheRead;
  t.cacheWrite += u.cacheWrite;
}

export interface StreamRequest {
  model: string;
  segments: PromptSegment[];
  maxTokens: number;
  reasoning: Reasoning;
  onDelta?: (text: string) => void;
}

export interface StructuredRequest {
  model: string;
  segments: PromptSegment[];
  maxTokens: number;
  reasoning: Reasoning;
  schemaName: string;
  schema: Record<string, unknown>;
}

export interface LLMResult {
  text: string;
  usage: Usage;
}

export interface LLMProvider {
  readonly name: string;
  streamText(req: StreamRequest): Promise<LLMResult>;
  completeStructured(req: StructuredRequest): Promise<LLMResult>;
}

// Split a segment list into leading system text and the alternating turn
// segments, merging consecutive same-role turns. Shared by all providers.
export function partitionSegments(segments: PromptSegment[]): {
  system: PromptSegment[];
  turns: { role: "user" | "assistant"; parts: PromptSegment[] }[];
} {
  const system = segments.filter((s) => s.role === "system");
  const turns: { role: "user" | "assistant"; parts: PromptSegment[] }[] = [];
  for (const seg of segments) {
    if (seg.role === "system") continue;
    const last = turns[turns.length - 1];
    if (last && last.role === seg.role) last.parts.push(seg);
    else turns.push({ role: seg.role, parts: [seg] });
  }
  return { system, turns };
}

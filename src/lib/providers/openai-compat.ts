// OpenAI-compatible implementation of LLMProvider via raw fetch — no SDK
// dependency, so one class covers OpenAI, DeepSeek, Groq, Together, Fireworks,
// and any other endpoint that speaks the Chat Completions API.
//
// Caching: these providers cache repeated prefixes automatically, so the
// `cacheable` segment hint is ignored here. Reasoning: not mapped in v1 (models
// vary in whether they accept reasoning_effort); revisit per-model if needed.

import {
  emptyUsage,
  partitionSegments,
  type LLMProvider,
  type LLMResult,
  type StreamRequest,
  type StructuredRequest,
  type Usage,
} from "../provider-types";

interface OAIMessage {
  role: "system" | "user" | "assistant";
  content: string | unknown[]; // array form carries images (image_url parts)
}

function toMessages(segments: StreamRequest["segments"]): OAIMessage[] {
  const { system, turns } = partitionSegments(segments);
  const out: OAIMessage[] = [];
  if (system.length > 0) {
    out.push({ role: "system", content: system.map((s) => s.text).join("\n\n") });
  }
  for (const t of turns) {
    if (!t.parts.some((p) => p.imageBase64)) {
      out.push({ role: t.role, content: t.parts.map((p) => p.text).filter(Boolean).join("\n\n") });
      continue;
    }
    const content: unknown[] = [];
    for (const p of t.parts) {
      if (p.imageBase64) {
        content.push({
          type: "image_url",
          image_url: { url: `data:${p.imageMediaType || "image/jpeg"};base64,${p.imageBase64}` },
        });
      }
      if (p.text) content.push({ type: "text", text: p.text });
    }
    out.push({ role: t.role, content });
  }
  return out;
}

function usageOf(u: any): Usage {
  const cached = u?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    input: Math.max(0, (u?.prompt_tokens ?? 0) - cached),
    output: u?.completion_tokens ?? 0,
    cacheRead: cached,
    cacheWrite: 0, // not separately reported; auto-cache
  };
}

export class OpenAICompatProvider implements LLMProvider {
  readonly name: string;
  private endpoint: string;
  private apiKey: string;
  private extraBody: Record<string, unknown>;

  constructor(name: string, baseUrl: string, apiKeyEnv: string, extraBody: Record<string, unknown> = {}) {
    this.name = name;
    this.endpoint = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
    const key = process.env[apiKeyEnv];
    if (!key) {
      throw new Error(`missing ${apiKeyEnv} for provider "${name}" (set it in .env)`);
    }
    this.apiKey = key;
    this.extraBody = extraBody;
  }

  // Signal lets the caller abort a request that hangs (no timeout on fetch = a
  // stuck upstream would hold the connection forever).
  private async post(body: unknown, signal?: AbortSignal): Promise<Response> {
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`${this.name} HTTP ${res.status}: ${detail.slice(0, 300)}`);
    }
    return res;
  }

  async streamText(req: StreamRequest): Promise<LLMResult> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120_000); // total cap (aborts a hung stream)
    try {
      const res = await this.post(
        {
          ...this.extraBody,
          model: req.model,
          max_tokens: req.maxTokens,
          messages: toMessages(req.segments),
          stream: true,
          stream_options: { include_usage: true },
        },
        ctrl.signal,
      );
      if (!res.body) throw new Error(`${this.name}: no response body`);

      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      let text = "";
      let reasoning = ""; // thinking models (e.g. Kimi K3) may put output here with content empty
      let usage = emptyUsage();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() || "";
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith("data:")) continue;
          const payload = t.slice(5).trim();
          if (payload === "[DONE]") continue;
          const ev = JSON.parse(payload);
          const delta = ev.choices?.[0]?.delta;
          if (delta?.content) {
            text += delta.content;
            req.onDelta?.(delta.content);
          }
          if (delta?.reasoning_content) reasoning += delta.reasoning_content;
          if (ev.usage) usage = usageOf(ev.usage);
        }
      }
      // Fallback: a reasoning model that emitted only thinking and no content
      // (else the answer comes back empty — the esc-grpo failure).
      if (!text.trim() && reasoning.trim()) {
        text = reasoning;
        req.onDelta?.(reasoning);
      }
      return { text, usage };
    } finally {
      clearTimeout(timer);
    }
  }

  async completeStructured(req: StructuredRequest): Promise<LLMResult> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120_000);
    let res: Response;
    try {
      res = await this.post(
        {
          ...this.extraBody,
          model: req.model,
          max_tokens: req.maxTokens,
          messages: toMessages(req.segments),
          response_format: {
            type: "json_schema",
            json_schema: { name: req.schemaName, schema: req.schema, strict: true },
          },
        },
        ctrl.signal,
      );
    } finally {
      clearTimeout(timer);
    }
    const json = await res.json();
    const choice = json.choices?.[0];
    if (choice?.finish_reason === "length") {
      throw new Error(`${this.name} structured output truncated (${req.schemaName})`);
    }
    return { text: choice?.message?.content ?? "", usage: usageOf(json.usage) };
  }
}

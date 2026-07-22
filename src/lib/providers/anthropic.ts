// Anthropic implementation of LLMProvider. Realizes caching via explicit
// cache_control breakpoints on `cacheable` segments, and maps the neutral
// reasoning hint to adaptive thinking + effort (gated by model support).

import Anthropic from "@anthropic-ai/sdk";
import { supportsAdaptiveThinking } from "../models";
import {
  partitionSegments,
  type LLMProvider,
  type LLMResult,
  type Reasoning,
  type StreamRequest,
  type StructuredRequest,
  type Usage,
} from "../provider-types";

function usageOf(u: Anthropic.Usage): Usage {
  return {
    input: u.input_tokens ?? 0,
    output: u.output_tokens ?? 0,
    cacheRead: u.cache_read_input_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
  };
}

function systemBlocks(
  system: { text: string; cacheable?: boolean }[],
): Anthropic.TextBlockParam[] {
  return system.map((s) => ({
    type: "text",
    text: s.text,
    ...(s.cacheable ? { cache_control: { type: "ephemeral" as const } } : {}),
  }));
}

function messages(
  turns: {
    role: "user" | "assistant";
    parts: { text: string; cacheable?: boolean; imageBase64?: string; imageMediaType?: string }[];
  }[],
): Anthropic.MessageParam[] {
  return turns.map((turn) => ({
    role: turn.role,
    content: turn.parts.flatMap((p) => {
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (p.imageBase64) {
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: (p.imageMediaType as any) || "image/jpeg", data: p.imageBase64 },
        });
      }
      if (p.text) {
        blocks.push({
          type: "text",
          text: p.text,
          ...(p.cacheable ? { cache_control: { type: "ephemeral" as const } } : {}),
        });
      }
      return blocks;
    }),
  }));
}

// Reasoning → thinking/effort, gated on model support (older models 400 on both).
function reasoningParams(model: string, reasoning: Reasoning) {
  if (reasoning === "none" || !supportsAdaptiveThinking(model)) return {};
  if (reasoning === "fast") {
    return { thinking: { type: "adaptive" as const }, output_config: { effort: "low" as const } };
  }
  return { thinking: { type: "adaptive" as const } }; // thorough
}

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  private client = new Anthropic({ timeout: 120_000 }); // don't let a hung request hold the connection

  async streamText(req: StreamRequest): Promise<LLMResult> {
    const { system, turns } = partitionSegments(req.segments);
    const stream = this.client.messages.stream({
      model: req.model,
      max_tokens: req.maxTokens,
      ...reasoningParams(req.model, req.reasoning),
      system: systemBlocks(system),
      messages: messages(turns),
    });
    if (req.onDelta) stream.on("text", req.onDelta);
    const final = await stream.finalMessage();
    const text = final.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    return { text, usage: usageOf(final.usage) };
  }

  async completeStructured(req: StructuredRequest): Promise<LLMResult> {
    const { system, turns } = partitionSegments(req.segments);
    // Structured output carries output_config.format, so only thinking is
    // added here (no effort). Gated on model support.
    const useThinking =
      req.reasoning !== "none" && supportsAdaptiveThinking(req.model);
    const response = await this.client.messages.create({
      model: req.model,
      max_tokens: req.maxTokens,
      ...(useThinking ? { thinking: { type: "adaptive" as const } } : {}),
      output_config: { format: { type: "json_schema", schema: req.schema } },
      system: systemBlocks(system),
      messages: messages(turns),
    });
    if (response.stop_reason === "max_tokens") {
      throw new Error(`anthropic structured output truncated at max_tokens (${req.schemaName})`);
    }
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    return { text, usage: usageOf(response.usage) };
  }
}

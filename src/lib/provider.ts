// Provider-neutral LLM interface. The app builds prompts as PromptSegments and
// calls a provider; each provider realizes caching, reasoning, and structured
// output in its own dialect. Config is a "provider:model" spec (bare strings
// default to anthropic for backward compatibility).
//
// No import cycle: providers import from ./provider-types (types only), never
// from this file, so static imports are safe.

import type { LLMProvider } from "./provider-types";
import { AnthropicProvider } from "./providers/anthropic";
import { OpenAICompatProvider } from "./providers/openai-compat";
export * from "./provider-types";

// Lazily-constructed, cached provider instances keyed by provider name.
const cache = new Map<string, LLMProvider>();

export interface ResolvedModel {
  provider: LLMProvider;
  model: string;
  spec: string; // the original "provider:model" string, for logging
}

// OpenAI-compatible endpoints reachable with just a base URL + API key.
interface CompatConfig {
  baseUrl: string;
  apiKeyEnv: string;
  extraBody?: Record<string, unknown>; // merged into every request body for this provider
}
const COMPAT: Record<string, CompatConfig> = {
  openai: { baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY" },
  // DeepSeek V4 has "thinking" ON by default (~4-5s to first token) — disable it for the
  // low-latency voice path. Remove extraBody if you want its reasoning mode back.
  deepseek: { baseUrl: "https://api.deepseek.com/v1", apiKeyEnv: "DEEPSEEK_API_KEY", extraBody: { thinking: { type: "disabled" } } },
  groq: { baseUrl: "https://api.groq.com/openai/v1", apiKeyEnv: "GROQ_API_KEY" },
  together: { baseUrl: "https://api.together.xyz/v1", apiKeyEnv: "TOGETHER_API_KEY" },
  fireworks: { baseUrl: "https://api.fireworks.ai/inference/v1", apiKeyEnv: "FIREWORKS_API_KEY" },
  // Kimi (Moonshot) and GLM (Zhipu) — OpenAI-compatible. Base URLs are
  // region/version-dependent; if a call 404s, set RYH_COMPAT_BASE_URL and use
  // the `compat:` provider instead, or fix the URL here. (.cn hosts also exist.)
  moonshot: { baseUrl: "https://api.moonshot.ai/v1", apiKeyEnv: "MOONSHOT_API_KEY" }, // Kimi
  zhipu: { baseUrl: "https://api.z.ai/api/paas/v4", apiKeyEnv: "ZHIPU_API_KEY" }, // GLM
  // Generic escape hatch: point at any OpenAI-compatible endpoint via env.
  compat: { baseUrl: process.env.RYH_COMPAT_BASE_URL ?? "", apiKeyEnv: "RYH_COMPAT_API_KEY" },
};

function getOrMake(key: string, make: () => LLMProvider): LLMProvider {
  let p = cache.get(key);
  if (!p) {
    p = make();
    cache.set(key, p);
  }
  return p;
}

export function resolveModel(spec: string): ResolvedModel {
  const idx = spec.indexOf(":");
  const provider = idx < 0 ? "anthropic" : spec.slice(0, idx);
  const model = idx < 0 ? spec : spec.slice(idx + 1);

  if (provider === "anthropic") {
    return { provider: getOrMake("anthropic", () => new AnthropicProvider()), model, spec };
  }

  if (provider === "gemini") {
    throw new Error(
      "gemini provider not implemented yet — add src/lib/providers/gemini.ts (REST generateContent + context caching). Use anthropic: or an openai-compatible provider (openai:, deepseek:, groq:, together:, fireworks:) for now.",
    );
  }

  const compat = COMPAT[provider];
  if (compat) {
    if (!compat.baseUrl) {
      throw new Error(`provider "${provider}" needs RYH_COMPAT_BASE_URL set`);
    }
    const p = getOrMake(
      `compat:${provider}`,
      () => new OpenAICompatProvider(provider, compat.baseUrl, compat.apiKeyEnv, compat.extraBody),
    );
    return { provider: p, model, spec };
  }

  throw new Error(
    `unknown provider "${provider}" in "${spec}". Known: anthropic, openai, deepseek, groq, together, fireworks, compat (gemini not yet implemented).`,
  );
}

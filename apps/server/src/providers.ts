// ============================================================
// AI Commander — LLM Provider Abstraction
// Supports DeepSeek (default), OpenAI-compatible, and Claude APIs
// Switch via LLM_PROVIDER env var: "deepseek" | "openai" | "claude"
// ============================================================

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
}

export interface LLMProvider {
  name: string;
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
  chatStream?(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<string>;
}

// ── OpenAI-compatible provider (works for DeepSeek + OpenAI) ──

class OpenAICompatibleProvider implements LLMProvider {
  name: string;
  private apiKey: string;
  private baseUrl: string;
  private model: string;

  constructor(name: string, apiKey: string, baseUrl: string, model: string) {
    this.name = name;
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.model = model;
  }

  // Gemini 2.5 defaults to `thinkingBudget=-1` (dynamic thinking) which silently
  // consumes max_tokens budget and truncates visible output mid-stream.
  // Per Gemini OpenAI-compat docs, `reasoning_effort="none"` disables thinking
  // for 2.5 models. The max_tokens bump is belt-and-suspenders.
  //
  // Note: briefly tried "low" to enable consultation nuance. Reverted because
  // Gemini batches visible chunks during the reasoning phase, breaking the
  // smooth char-by-char streaming feel that's core to the radio-chatter UX.
  // Consultation handling ("你觉得如何?" vs "进攻") is now a Chen prompt-level
  // rule, not a model-reasoning trick.
  private applyGeminiQuirks(body: Record<string, unknown>): void {
    if (this.name !== "gemini") return;
    body.reasoning_effort = "none";
    if ((body.max_tokens as number) < 4000) body.max_tokens = 4000;
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? 800,
    };
    if (options?.jsonMode) {
      body.response_format = { type: "json_object" };
    }
    this.applyGeminiQuirks(body);

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`LLM API ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error("LLM returned empty response");
    }
    return content;
  }

  async *chatStream(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      temperature: options?.temperature ?? 0.7,
      max_tokens: options?.maxTokens ?? 800,
      stream: true,
    };
    // No jsonMode for streaming — first half is natural language
    this.applyGeminiQuirks(body);

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`LLM API ${res.status}: ${text.slice(0, 200)}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error("No response body for streaming");

    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;
          const payload = trimmed.slice(6);
          if (payload === "[DONE]") return;
          try {
            const chunk = JSON.parse(payload);
            const delta = chunk.choices?.[0]?.delta?.content;
            if (typeof delta === "string") yield delta;
          } catch { /* skip malformed chunks */ }
        }
      }
      // Flush remaining buffer on EOF
      if (buffer.trim()) {
        const trimmed = buffer.trim();
        if (trimmed.startsWith("data: ")) {
          const payload = trimmed.slice(6);
          if (payload !== "[DONE]") {
            try {
              const chunk = JSON.parse(payload);
              const delta = chunk.choices?.[0]?.delta?.content;
              if (typeof delta === "string") yield delta;
            } catch { /* skip */ }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

// ── Claude provider (Anthropic Messages API) ──

class ClaudeProvider implements LLMProvider {
  name = "claude";
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.apiKey = apiKey;
    this.model = model;
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    const systemMsg = messages.find((m) => m.role === "system");
    const nonSystemMsgs = messages.filter((m) => m.role !== "system");

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: options?.maxTokens ?? 800,
        system: systemMsg?.content ?? "",
        messages: nonSystemMsgs.map((m) => ({ role: m.role, content: m.content })),
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Claude API ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = await res.json();
    const content = data.content?.[0]?.text;
    if (typeof content !== "string") {
      throw new Error("Claude returned empty response");
    }
    return content;
  }

  async *chatStream(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<string> {
    const systemMsg = messages.find((m) => m.role === "system");
    const nonSystemMsgs = messages.filter((m) => m.role !== "system");

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: options?.maxTokens ?? 800,
        system: systemMsg?.content ?? "",
        messages: nonSystemMsgs.map((m) => ({ role: m.role, content: m.content })),
        stream: true,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Claude API ${res.status}: ${text.slice(0, 200)}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error("No response body for streaming");

    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;
          const payload = trimmed.slice(6);
          if (payload === "[DONE]") return;
          try {
            const event = JSON.parse(payload);
            if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
              yield event.delta.text;
            }
          } catch { /* skip malformed chunks */ }
        }
      }
      // Flush remaining buffer on EOF
      if (buffer.trim()) {
        const trimmed = buffer.trim();
        if (trimmed.startsWith("data: ")) {
          const payload = trimmed.slice(6);
          if (payload !== "[DONE]") {
            try {
              const event = JSON.parse(payload);
              if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
                yield event.delta.text;
              }
            } catch { /* skip */ }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

// ── Factory ──

export interface ProviderConfig {
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  keyEnvVar?: string;
}

// Curated presets — switch by setting LLM_PROFILE=<key> in .env.
// Falls back to legacy LLM_PROVIDER-based config when LLM_PROFILE is unset.
interface ProfileDef {
  provider: string;
  baseUrl: string;
  model: string;
  keyEnvVar: string;
}

const PROFILES: Record<string, ProfileDef> = {
  "deepseek": {
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    keyEnvVar: "DEEPSEEK_API_KEY",
  },
  "gemini-2.5-flash": {
    provider: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.5-flash",
    keyEnvVar: "GEMINI_API_KEY",
  },
  "gemini-2.5-flash-lite": {
    provider: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.5-flash-lite",
    keyEnvVar: "GEMINI_API_KEY",
  },
  "gemini-3.1-flash-lite-preview": {
    provider: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-3.1-flash-lite-preview",
    keyEnvVar: "GEMINI_API_KEY",
  },
};

export function getProviderConfig(): ProviderConfig {
  // Preferred: LLM_PROFILE selects a curated preset.
  const profile = process.env.LLM_PROFILE?.toLowerCase();
  if (profile && PROFILES[profile]) {
    const p = PROFILES[profile];
    return {
      provider: p.provider,
      baseUrl: p.baseUrl,
      model: p.model,
      apiKey: process.env[p.keyEnvVar] || "",
      keyEnvVar: p.keyEnvVar,
    };
  }

  // Legacy fallback: LLM_PROVIDER-based.
  const provider = (process.env.LLM_PROVIDER || "deepseek").toLowerCase();
  let apiKey = "";
  let baseUrl = "";
  let model = "";
  let keyEnvVar = "DEEPSEEK_API_KEY";

  switch (provider) {
    case "openai":
      apiKey = process.env.OPENAI_API_KEY || "";
      baseUrl = process.env.LLM_BASE_URL || "https://api.openai.com/v1";
      model = process.env.LLM_MODEL || "gpt-4o-mini";
      keyEnvVar = "OPENAI_API_KEY";
      break;
    case "claude":
      apiKey = process.env.ANTHROPIC_API_KEY || "";
      baseUrl = ""; // not used
      model = process.env.LLM_MODEL || "claude-sonnet-4-20250514";
      keyEnvVar = "ANTHROPIC_API_KEY";
      break;
    default: // deepseek
      apiKey = process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || "";
      baseUrl = process.env.LLM_BASE_URL || "https://api.deepseek.com/v1";
      model = process.env.LLM_MODEL || "deepseek-chat";
      keyEnvVar = "DEEPSEEK_API_KEY";
      break;
  }

  return { provider, apiKey, baseUrl, model, keyEnvVar };
}

export function createProvider(config: ProviderConfig): LLMProvider {
  if (config.provider === "claude") {
    return new ClaudeProvider(config.apiKey, config.model);
  }
  // deepseek, openai, or any OpenAI-compatible
  return new OpenAICompatibleProvider(config.provider, config.apiKey, config.baseUrl, config.model);
}

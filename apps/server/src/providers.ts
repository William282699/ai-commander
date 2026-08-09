// ============================================================
// AI Commander — LLM Provider Abstraction
// Supports DeepSeek (default), OpenAI-compatible, and Claude APIs
// Switch via LLM_PROVIDER env var: "deepseek" | "openai" | "claude"
// ============================================================

// ── 语音输入 V1：音频附件与多模态 content ──
//
// 三个"缝"在这里命名导出（AudioAttachment / buildContent / channelAcceptsAudio），
// 不是为了好看：V1.5 的 ops 转写中继（/api/transcribe）要复用同一套线上形状，
// 若把类型内联进调用点、把 provider 判定抄进路由 handler，中继就只能复制第二份
// ——placeNameAt 与 getFrontCenterPos 那一族的病。命名一次，两边共用。

/** 一段录音。V1 只有 wav（探针实证该端点吃 wav；webm/opus 未测）。 */
export interface AudioAttachment {
  /** base64，不带 `data:` 前缀 */
  data: string;
  format: "wav";
}

/** OpenAI 兼容多模态片段。纯文本调用继续直接传 string，不包装。 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "input_audio"; input_audio: { data: string; format: string } };

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}

/**
 * 把「文本 + 可选音频」拼成 provider 认得的 content。
 *
 * ★ 无音频时返回**传进来的那个字符串本身**（不是等值的新串）——这是"信封拼装
 * 零改动"负对照的地基：打字回合走到这里等同于没走，assembly 逐字节不可能变。
 */
export function buildContent(text: string, audio?: AudioAttachment): string | ContentPart[] {
  if (!audio) return text;
  return [
    { type: "text", text },
    { type: "input_audio", input_audio: { data: audio.data, format: audio.format } },
  ];
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

  /**
   * fail-closed：Anthropic 的多模态是另一套 block 格式，这里绝不静默把音频丢掉
   * 再当纯文本发出去——那会变成"长官说了话、模型什么都没听见、引擎照样出单"。
   * 注意这**只是第二道**：第一道是 channelAcceptsAudio（挂 provider 能力，
   * 而不是挂 provider 类）——deepseek 与 gemini 共用 OpenAICompatibleProvider，
   * 只在这里 throw 挡不住 ops。
   */
  private assertTextOnly(messages: ChatMessage[]): void {
    if (messages.some((m) => typeof m.content !== "string")) {
      throw new Error("ClaudeProvider 不支持多模态 content parts（fail-closed）");
    }
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    this.assertTextOnly(messages);
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
    this.assertTextOnly(messages);
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

export function getProviderConfig(channel?: string): ProviderConfig {
  // Channel-specific override takes precedence: LLM_PROFILE_<CHANNEL_UPPER>
  if (channel) {
    const envKey = `LLM_PROFILE_${channel.toUpperCase()}`;
    const channelProfile = process.env[envKey]?.toLowerCase();
    if (channelProfile && PROFILES[channelProfile]) {
      const p = PROFILES[channelProfile];
      return {
        provider: p.provider,
        baseUrl: p.baseUrl,
        model: p.model,
        apiKey: process.env[p.keyEnvVar] || "",
        keyEnvVar: p.keyEnvVar,
      };
    }
  }

  // Default: LLM_PROFILE selects a curated preset.
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

// ── 语音输入 V1：哪些频道的耳朵吃得下音频 ──
//
// 双条件，缺一不可：
//   ① 显式白名单＝**语义闸**。.env 只设了 LLM_PROFILE 与 LLM_PROFILE_OPS，
//      所以 group 的 provider 同样是 gemini——单靠 provider 推导会把群聊圈进来，
//      而 GROUP_SYSTEM_PROMPT 是冻结面（D2）；ops 用的是 deepseek 那颗脑子，
//      换耳朵归 V1.5 的转写中继，不归这条通道。
//   ② provider==="gemini"＝**配置闸**。将来 .env 换 profile，能力自动收回，
//      不会留下"白名单说可以、模型其实听不了"的洞。
const VOICE_INPUT_CHANNELS: readonly string[] = ["combat", "logistics"];

/** 服务端入场校验用（fail-closed 的第一道，也是唯一一道硬的）。 */
export function channelAcceptsAudio(channel?: string): boolean {
  if (!channel || !VOICE_INPUT_CHANNELS.includes(channel)) return false;
  return getProviderConfig(channel).provider === "gemini";
}

/** /api/health 报给客户端的名单；不在名单里的频道，🎤 走现状 Web Speech。 */
export function voiceEnabledChannels(): string[] {
  return VOICE_INPUT_CHANNELS.filter((ch) => getProviderConfig(ch).provider === "gemini");
}

// ── Per-channel diagnostics (D2=B: strict isProviderConfigured) ──

export interface ChannelDiagnostic {
  channel: string;       // "default", "combat", "ops", etc.
  profile: string;       // resolved profile name OR legacy descriptor
  model: string;         // resolved model
  keyEnvVar: string;
  keyPresent: boolean;
}

const KNOWN_CHANNELS = ["combat", "ops", "logistics", "group"] as const;

/**
 * Inspect all configured LLM channels and report key/profile state.
 * Used by isProviderConfigured() (strict mode) and boot logging.
 *
 * Returns "default" entry plus one entry per LLM_PROFILE_<CHANNEL> env var
 * that's set. Channels without explicit overrides aren't listed (they fall
 * back to default at runtime).
 */
export function describeProviderConfig(): ChannelDiagnostic[] {
  const result: ChannelDiagnostic[] = [];

  // Default profile (used when no channel-specific override matches)
  const defaultConfig = getProviderConfig();
  const defaultProfile = process.env.LLM_PROFILE
    || `(legacy LLM_PROVIDER=${process.env.LLM_PROVIDER || "deepseek"})`;
  result.push({
    channel: "default",
    profile: defaultProfile,
    model: defaultConfig.model,
    keyEnvVar: defaultConfig.keyEnvVar || "?",
    keyPresent: !!defaultConfig.apiKey,
  });

  // Channel-specific overrides
  for (const ch of KNOWN_CHANNELS) {
    const envKey = `LLM_PROFILE_${ch.toUpperCase()}`;
    const profile = process.env[envKey]?.toLowerCase();
    if (!profile) continue;
    const channelConfig = getProviderConfig(ch);
    result.push({
      channel: ch,
      profile,
      model: channelConfig.model,
      keyEnvVar: channelConfig.keyEnvVar || "?",
      keyPresent: !!channelConfig.apiKey,
    });
  }

  return result;
}

export function createProvider(config: ProviderConfig): LLMProvider {
  if (config.provider === "claude") {
    return new ClaudeProvider(config.apiKey, config.model);
  }
  // deepseek, openai, or any OpenAI-compatible
  return new OpenAICompatibleProvider(config.provider, config.apiKey, config.baseUrl, config.model);
}

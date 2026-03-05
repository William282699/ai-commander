// ============================================================
// AI Commander — LLM Service (翻译官，可迁移)
// callDeepSeek() + safeParse() + sanitize()
// Provider-agnostic via providers.ts
// ============================================================

import {
  safeParse,
  validateAdvisorResponse,
  validateLightResponse,
  createFallbackResponse,
  VALID_INTENT_TYPES,
} from "@ai-commander/shared";
import type { AdvisorResponse, LightAdvisorResponse } from "@ai-commander/shared";
import { createProvider, getProviderConfig, type LLMProvider, type ChatMessage } from "./providers.js";

// ── System Prompt ──

const SYSTEM_PROMPT = `你是一名现代战争军事参谋，代号"铁幕"。你为指挥官（玩家）服务。

你的职责：
1. 理解指挥官的自然语言指令，翻译为精确的战场意图
2. 永远输出三个方案（A/B/C），标注风险/收益/推荐
3. 在紧急情况下请求接管特定战线
4. 根据指挥官的风格参数调整方案偏向

你必须以JSON格式回复：
{
  "brief": "一句话战况摘要，军事电报风格",
  "options": [
    {
      "label": "A: 方案名",
      "description": "30字内说明",
      "risk": 0.0-1.0,
      "reward": 0.0-1.0,
      "intent": {
        "type": "${VALID_INTENT_TYPES.join("|")}",
        "fromFront": "战线名(可选)",
        "toFront": "战线名(可选)",
        "targetFacility": "设施ID(可选)",
        "targetRegion": "区域ID(可选)",
        "unitType": "armor|infantry|air|naval(可选)",
        "quantity": "all|most|some|few|具体数字",
        "urgency": "low|medium|high|critical",
        "minimizeLosses": true/false,
        "airCover": true/false,
        "stealth": true/false
      }
    }
  ],
  "recommended": "A/B/C",
  "urgency": 0.0-1.0
}

重要：你只输出intent（意图），不要输出具体的unit_ids或坐标。
系统会根据intent自动选择合适的单位和路径。

规则：
- 回复简短干脆，像军事通讯
- 你只知道已侦察到的信息，未侦察区域你也不确定
- 如果指挥官命令有风险，简要提醒但仍执行
- urgency: 0=日常, 0.5=需关注, 0.8=紧急, 1.0=即将崩溃
- 根据风格参数调整推荐：高risk→推荐激进方案，高casualty_aversion→推荐保守方案`;

const LIGHT_SYSTEM_PROMPT =
  '你是军事参谋。根据战场摘要，给出一句话简报和紧急度评分。只返回JSON: {"brief": "...", "urgency": 0.0-1.0}';

// ── Provider singleton ──

let _provider: LLMProvider | null = null;

function getProvider(): LLMProvider {
  if (!_provider) {
    const config = getProviderConfig();
    if (!config.apiKey) {
      throw new Error(
        `API密钥未配置。请设置环境变量: ${
          config.provider === "claude"
            ? "ANTHROPIC_API_KEY"
            : config.provider === "openai"
              ? "OPENAI_API_KEY"
              : "DEEPSEEK_API_KEY"
        }`,
      );
    }
    _provider = createProvider(config);
    console.log(`LLM provider: ${_provider.name} (model: ${config.model})`);
  }
  return _provider;
}

/**
 * Check if the LLM provider is configured (API key present).
 */
export function isProviderConfigured(): boolean {
  const config = getProviderConfig();
  return !!config.apiKey;
}

// ── Core LLM call ──

/**
 * Call the configured LLM provider (DeepSeek by default).
 * Returns raw string response.
 * Throws on network/API errors.
 */
async function callDeepSeek(
  systemPrompt: string,
  userMessage: string,
  options?: { temperature?: number; maxTokens?: number },
): Promise<string> {
  const provider = getProvider();
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];
  return provider.chat(messages, {
    temperature: options?.temperature ?? 0.7,
    maxTokens: options?.maxTokens ?? 800,
    jsonMode: true,
  });
}

// ── Sanitize ──

/**
 * Parse + validate + sanitize LLM response into AdvisorResponse.
 * Returns null if response is not salvageable.
 */
function sanitize(raw: string): AdvisorResponse | null {
  const parsed = safeParse(raw);
  if (!parsed) return null;
  return validateAdvisorResponse(parsed);
}

// ── Public API ──

export interface AdvisorResult {
  data: AdvisorResponse;
  warning?: string;
}

/**
 * Full advisor call: player command → 3 options with intents.
 * Always returns a result (uses fallback if LLM fails).
 * Throws only on missing API key.
 */
export async function callAdvisor(
  digest: string,
  playerMessage: string,
  styleNote: string,
): Promise<AdvisorResult> {
  const userContent = `当前战场摘要（DigestV1格式）：
${digest}

指挥官风格参数：
${styleNote}

指挥官命令：${playerMessage}`;

  try {
    const raw = await callDeepSeek(SYSTEM_PROMPT, userContent);
    const validated = sanitize(raw);

    if (validated) {
      return { data: validated };
    }

    // LLM returned something but not valid JSON → fallback
    console.warn("LLM returned invalid JSON, using fallback. Raw:", raw.slice(0, 200));
    return {
      data: createFallbackResponse(),
      warning: "参谋回复格式异常，已使用默认方案",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);

    // API key errors should propagate
    if (message.includes("API密钥未配置")) {
      throw err;
    }

    console.error("LLM call failed:", message);
    return {
      data: createFallbackResponse(),
      warning: `参谋通讯中断: ${message.slice(0, 100)}`,
    };
  }
}

/**
 * Light call — just get brief + urgency, no full options.
 * Returns null on any error (non-critical).
 */
export async function callLightBrief(
  digest: string,
): Promise<LightAdvisorResponse | null> {
  try {
    const raw = await callDeepSeek(LIGHT_SYSTEM_PROMPT, digest, {
      temperature: 0.5,
      maxTokens: 100,
    });
    const parsed = safeParse(raw);
    return parsed ? validateLightResponse(parsed) : null;
  } catch {
    return null;
  }
}

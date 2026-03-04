// ============================================================
// AI Commander — LLM Service (翻译官，可迁移)
// Calls DeepSeek/Claude/OpenAI and returns validated responses
// ============================================================

import { safeParse, validateAdvisorResponse, validateLightResponse } from "@ai-commander/shared";
import type { AdvisorResponse, LightAdvisorResponse } from "@ai-commander/shared";

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
        "type": "reinforce|attack|defend|retreat|flank|sabotage|recon|escort|air_support|produce|trade",
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
- urgency: 0=日常, 0.5=需关注, 0.8=紧急, 1.0=即将崩溃`;

interface LLMConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

function getConfig(): LLMConfig {
  return {
    apiKey: process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY || "",
    baseUrl: process.env.LLM_BASE_URL || "https://api.deepseek.com/v1",
    model: process.env.LLM_MODEL || "deepseek-chat",
  };
}

/**
 * Call LLM with battlefield digest and player message.
 * Returns validated AdvisorResponse or null.
 */
export async function callAdvisor(
  digest: string,
  playerMessage: string,
  styleNote: string,
): Promise<AdvisorResponse | null> {
  const config = getConfig();
  if (!config.apiKey) {
    console.warn("No LLM API key configured");
    return null;
  }

  const userContent = `当前战场摘要（DigestV1格式）：
${digest}

指挥官风格参数：
${styleNote}

指挥官命令：${playerMessage}`;

  try {
    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userContent },
        ],
        temperature: 0.7,
        max_tokens: 800,
        response_format: { type: "json_object" },
      }),
    });

    if (!res.ok) {
      console.error("LLM API error:", res.status, await res.text());
      return null;
    }

    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content ?? "";
    const parsed = safeParse(raw);
    return parsed ? validateAdvisorResponse(parsed) : null;
  } catch (err) {
    console.error("LLM call failed:", err);
    return null;
  }
}

/**
 * Light call — just get brief + urgency, no full options.
 */
export async function callLightBrief(
  digest: string,
): Promise<LightAdvisorResponse | null> {
  const config = getConfig();
  if (!config.apiKey) return null;

  try {
    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: "你是军事参谋。根据战场摘要，给出一句话简报和紧急度评分。只返回JSON: {\"brief\": \"...\", \"urgency\": 0.0-1.0}" },
          { role: "user", content: digest },
        ],
        temperature: 0.5,
        max_tokens: 100,
        response_format: { type: "json_object" },
      }),
    });

    if (!res.ok) return null;
    const data = await res.json();
    const raw = data.choices?.[0]?.message?.content ?? "";
    const parsed = safeParse(raw);
    return parsed ? validateLightResponse(parsed) : null;
  } catch {
    return null;
  }
}
